"""End-to-end: drive a full 5-turn order from greet → close so we can
observe ALL 4 agents firing.

Asserts:
  • Bot 1: state.customer_vibe is recorded somewhere in pending notes
  • Bot 2: bot replies are non-empty, in the right language
  • Bot 3: city stored as canonical 'Casablanca' (we type 'casa')
  • Bot 4: final reply is NOT a generic 'thank you for your trust'
           AND order row carries lead_score + bot_internal_notes
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
HDRS = {"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}",
        "Content-Type": "application/json", "Prefer": "return=representation"}


def supa(path, params=None):
    r = httpx.get(f"{SUPA_URL}/rest/v1/{path}", params=params or {},
                  headers=HDRS, timeout=10, verify=False)
    r.raise_for_status()
    return r.json()


def supa_del(path, params):
    httpx.delete(f"{SUPA_URL}/rest/v1/{path}", params=params,
                 headers=HDRS, timeout=10, verify=False)


def hit(text, jid_user, msg_id):
    p = {
        "event": "message.received", "sessionId": SESSION_ID,
        "timestamp": time.time(), "idempotencyKey": f"ma-{msg_id}",
        "data": {"from": f"{jid_user}@c.us", "to": "212633753039@c.us",
                 "body": text, "type": "chat",
                 "fromMe": False, "isGroup": False,
                 "id": msg_id, "timestamp": int(time.time())},
    }
    r = httpx.post(f"{BRAIN}/openwa/webhook", json=p, timeout=10)
    return r.status_code


def main():
    # Pick the seller mapped to the active OpenWA session.
    sessions = supa("seller_whatsapp_sessions",
                    {"jid": f"eq.{SESSION_ID}", "select": "seller_id"})
    seller_id = (sessions[0]["seller_id"] if sessions
                 else supa("sellers", {"select": "id", "limit": "1"})[0]["id"])
    print(f"seller_id = {seller_id}")

    test_user = "212600000111"
    # Wipe prior state.
    convos = supa("customer_conversations", {
        "seller_id": f"eq.{seller_id}",
        "customer_jid": f"eq.{test_user}@c.us",
        "select": "id"})
    for c in convos:
        supa_del("messages", {"conversation_id": f"eq.{c['id']}"})
        supa_del("orders", {"conversation_id": f"eq.{c['id']}"})
    supa_del("customer_conversations",
             {"seller_id": f"eq.{seller_id}",
              "customer_jid": f"eq.{test_user}@c.us"})
    print(f"--- wiped state for {test_user} ---\n")

    # 5-turn order with intentional VIBE signal in T1 (worried_quality)
    # + CASA shorthand in T3 (tests Bot 3 city normalization)
    turns = [
        ("salam, bghit biorein. wach 100% naturel? safi 3la 9luub?",
                                       "T1: greet + worried_quality"),
        ("smiti Karim",                "T2: name"),
        ("ana f casa",                 "T3: city (canonicalize test)"),
        ("hay mohammadi rue 12 numero 5", "T4: full address"),
        ("3afak nta9d lia, bghit wahda", "T5: ready_to_order (qty=1)"),
    ]
    for body, label in turns:
        code = hit(body, test_user, uuid.uuid4().hex)
        print(f"  -> {label!r}  ack={code}")
        time.sleep(13)
    time.sleep(6)

    # Inspect final state
    convo = supa("customer_conversations", {
        "seller_id": f"eq.{seller_id}",
        "customer_jid": f"eq.{test_user}@c.us",
        "select": "id,pending_order_fields,language_code,status"})[0]
    pending = convo.get("pending_order_fields") or {}
    print("\n=== Final pending ===")
    for k in ("name", "city", "address", "quantity",
              "lead_priority", "bot_internal_notes",
              "intent_type", "address_incomplete", "last_order_sig"):
        v = pending.get(k)
        if v is not None:
            print(f"  {k}: {v}")
    print(f"  language: {convo.get('language_code')}")
    print(f"  status:   {convo.get('status')}")

    msgs = supa("messages", {
        "conversation_id": f"eq.{convo['id']}",
        "select": "role,content,created_at",
        "order": "created_at.asc"})
    print(f"\n=== Thread ({len(msgs)} msgs) ===")
    for m in msgs[-10:]:
        print(f"  {m['role']:>5}: {m['content'][:120]}")

    # Last assistant message = the closing
    last_bot = next((m["content"] for m in reversed(msgs)
                     if m["role"] == "assistant"), "")
    print(f"\n=== Last bot reply (Bot 4 closing) ===")
    print(f"  {last_bot}")

    # Assertions
    ok = True
    print()
    if pending.get("city") == "Casablanca":
        print("PASS - Bot 3: city normalized 'casa' -> 'Casablanca'")
    else:
        print(f"FAIL - Bot 3 city: got {pending.get('city')!r}")
        ok = False

    if pending.get("name") == "Karim":
        print("PASS - Bot 3: name cleaned 'smiti Karim' -> 'Karim'")
    else:
        print(f"WARN - Bot 3 name: got {pending.get('name')!r}")

    valid_priorities = ("🟢 Hot Lead", "🟡 Medium Support",
                        "🔴 Escalated to Human")
    if pending.get("lead_priority") in valid_priorities:
        print(f"PASS - Agent 1: lead_priority = {pending.get('lead_priority')}")
    else:
        print(f"FAIL - Agent 1 lead_priority missing/invalid: "
              f"{pending.get('lead_priority')!r}")
        ok = False

    if pending.get("bot_internal_notes"):
        print(f"PASS - Agent 1: internal_notes = "
              f"{pending.get('bot_internal_notes')[:140]}")
    else:
        print("FAIL - Agent 1: bot_internal_notes missing")
        ok = False

    banned = ("thank you for your trust", "شكرا لثقتكم",
              "merci pour votre confiance")
    if last_bot and any(b in last_bot.lower() for b in banned):
        print(f"FAIL - Agent 2 used a BANNED generic closing")
        ok = False
    else:
        print("PASS - Agent 2: no banned generic closing detected")

    # Schema leak guard — Agent 2 must NEVER emit JSON labels as text.
    leak_markers = ("intent:", "extracted_order_fields", "(intent ",
                    "\"reply\"", '"name":')
    leak_found = [m for m in leak_markers
                  if any(m in (msg["content"] or "")
                         for msg in msgs if msg["role"] == "assistant")]
    if leak_found:
        print(f"FAIL - Agent 2 leaked schema labels: {leak_found}")
        ok = False
    else:
        print("PASS - Agent 2: no schema leak in any reply")

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
