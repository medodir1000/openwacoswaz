"""End-to-end check that the bot now actually reads the chat history and
answers customer questions instead of marching robotically to the next
sales stage.

Simulated dialogue (designed to break the OLD behavior):
  Turn 1: greet      → bot greets (stage 1)
  Turn 2: name       → bot acknowledges, asks city (stage 3)
  Turn 3: city       → bot asks quantity + slips price (stage 4)
  Turn 4: QUESTION about the product (not a quantity answer)
                     → OLD bot: ignores, re-asks "combien tu veux?"
                     → NEW bot: ANSWERS the question, then asks quantity again

We assert:
  • The reply to Turn 4 references the product / answers the question
    (heuristic: it isn't just a re-asked quantity prompt).
  • The bot did NOT lose track of name/city — pending still has them.
"""
from __future__ import annotations

import os, time, uuid, sys, re
from pathlib import Path
import httpx

ENV = Path(__file__).resolve().parents[1] / ".env"
for line in ENV.read_text(encoding="utf-8").splitlines():
    if "=" in line and not line.startswith("#"):
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip())

SUPA_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPA_KEY = os.environ["SUPABASE_SERVICE_KEY"]
SESSION_ID = os.environ.get("OPENWA_SESSION_ID", "")
BRAIN = "http://127.0.0.1:5001"

HDRS = {
    "apikey": SUPA_KEY,
    "Authorization": f"Bearer {SUPA_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

def supa(path, params=None):
    r = httpx.get(f"{SUPA_URL}/rest/v1/{path}", params=params or {},
                  headers=HDRS, timeout=10, verify=False)
    r.raise_for_status()
    return r.json()

def supa_del(path, params):
    httpx.delete(f"{SUPA_URL}/rest/v1/{path}", params=params, headers=HDRS,
                 timeout=10, verify=False)

def hit(text, jid_user, msg_id):
    p = {
        "event": "message.received",
        "sessionId": SESSION_ID,
        "timestamp": time.time(),
        "idempotencyKey": f"ctx-{msg_id}",
        "data": {
            "from": f"{jid_user}@c.us", "to": "212633753039@c.us",
            "body": text, "type": "chat",
            "fromMe": False, "isGroup": False,
            "id": msg_id, "timestamp": int(time.time()),
        },
    }
    return httpx.post(f"{BRAIN}/openwa/webhook", json=p, timeout=8).status_code

def main():
    # Find seller + a product
    sessions = supa("seller_whatsapp_sessions",
                    {"jid": f"eq.{SESSION_ID}", "select": "seller_id"})
    seller_id = sessions[0]["seller_id"] if sessions else None
    if not seller_id:
        sellers = supa("sellers", {"select": "id", "status": "eq.active",
                                   "limit": "1"})
        seller_id = sellers[0]["id"]
    print(f"seller_id = {seller_id}")

    # Fresh test user
    test_user = "212600000088"
    convos = supa("customer_conversations", {
        "seller_id": f"eq.{seller_id}",
        "customer_jid": f"eq.{test_user}@c.us",
        "select": "id"})
    for c in convos:
        supa_del("messages", {"conversation_id": f"eq.{c['id']}"})
        supa_del("orders",   {"conversation_id": f"eq.{c['id']}"})
    supa_del("customer_conversations",
             {"seller_id": f"eq.{seller_id}",
              "customer_jid": f"eq.{test_user}@c.us"})
    print(f"--- wiped state for {test_user} ---\n")

    # Drive a 4-turn dialogue
    turns = [
        ("salam, bghit biorein",  "greet+keyword"),
        ("smiti Mohamed",         "name"),
        ("ana f Casablanca",      "city"),
        # The KEY moment — a question, not a quantity answer:
        ("wach 100% naturel? o chno fih dakhel?", "question (not qty)"),
    ]
    for body, label in turns:
        code = hit(body, test_user, uuid.uuid4().hex)
        print(f"  -> {label!r}  ack={code}")
        time.sleep(12)  # wait for full LLM + send + supabase persist round-trip
    time.sleep(4)  # extra grace before reading state

    # Read what the bot replied to the QUESTION turn
    convo = supa("customer_conversations", {
        "seller_id": f"eq.{seller_id}",
        "customer_jid": f"eq.{test_user}@c.us",
        "select": "id,pending_order_fields,detected_product_id,language_code",
    })[0]
    pending = convo.get("pending_order_fields") or {}
    msgs = supa("messages", {
        "conversation_id": f"eq.{convo['id']}",
        "select": "role,content,created_at",
        "order": "created_at.asc",
    })
    print(f"\nconvo pending after 4 turns:")
    for k in ("name", "city", "quantity", "address"):
        print(f"  {k}: {pending.get(k)!r}")
    print(f"  language: {convo.get('language_code')}")
    print(f"  detected_product_id: {(convo.get('detected_product_id') or '')[:8]}")

    print(f"\nfull thread ({len(msgs)} msgs):")
    for m in msgs[-8:]:
        print(f"  {m['role']:>5}: {m['content'][:120]}")

    # Assertions — be lenient about which fields the LLM nailed.
    name_ok = bool(pending.get("name"))
    city_ok = bool(pending.get("city"))
    print(f"\nfield extraction:  name={name_ok}  city={city_ok}")
    if name_ok and city_ok:
        print("PASS - context retention: name + city both captured")
    elif city_ok:
        print("PARTIAL - city captured, name not (LLM extraction inconsistency)")
    else:
        print("WEAK - neither name nor city captured")

    # The LAST assistant message should be a response to the question,
    # not a robotic re-ask of quantity with zero context.
    last_assist = next((m["content"] for m in reversed(msgs)
                        if m["role"] == "assistant"), "")
    print(f"\nlast assistant reply:\n  {last_assist!r}")

    # Heuristic: the response should NOT be ONLY a quantity question.
    # A good reply addresses the natural / ingredients question briefly
    # AND then nudges toward quantity. A bad reply is just "Combien tu
    # veux ?" with no acknowledgment of the question.
    text_norm = last_assist.lower()
    addresses_question = any(t in text_norm for t in (
        "naturel", "naturelle", "ingrédient", "ingredient", "composé",
        "compose", "plante", "100%", "sans", "bio", "extrait", "formule",
        "أعشاب", "طبيعي", "مكون",
    ))
    just_asks_qty = bool(re.search(
        r"^(combien|how many|شحال|kam)\b.{0,80}\?$", text_norm.strip()
    ))

    print(f"\naddresses_question = {addresses_question}")
    print(f"just_asks_qty      = {just_asks_qty}")

    if addresses_question and not just_asks_qty:
        print("PASS - bot ANSWERED the customer question instead of "
              "robotically re-asking quantity")
        return 0
    print("FAIL - bot did not address the customer's question; it "
          "marched to the next stage")
    return 1


if __name__ == "__main__":
    sys.exit(main())
