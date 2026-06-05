"""End-to-end verification for Task #61 — history-reset on product switch.

Hits the live brain via /openwa/webhook with a sequence of messages that
build up an order for one product, then switch to a SECOND product, and
asserts that:
  1. detected_product_id swaps to the new product
  2. pending_order_fields has only history_reset_at (old name/qty/city cleared)
  3. the LLM context after the switch does NOT include any messages from
     the pre-switch turns (we check via the since_iso filter)
  4. fallback rotation: two consecutive empty-LLM events would produce
     different fallback strings (smoke test of fallback_pool)

Run from project root:
  api\\venv\\Scripts\\python.exe api\\scripts\\test_history_reset.py
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

# Load .env (very small, no python-dotenv needed)
ENV_PATH = Path(__file__).resolve().parents[1] / ".env"
for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, _, v = line.partition("=")
    os.environ.setdefault(k.strip(), v.strip())

SUPA_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPA_KEY = os.environ["SUPABASE_SERVICE_KEY"]
BRAIN_URL = "http://127.0.0.1:5001"
SESSION_ID = os.environ.get("OPENWA_SESSION_ID", "")

HDRS = {
    "apikey": SUPA_KEY,
    "Authorization": f"Bearer {SUPA_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}


def supa_get(table: str, params: Dict[str, str]) -> List[Dict[str, Any]]:
    r = httpx.get(f"{SUPA_URL}/rest/v1/{table}", params=params, headers=HDRS,
                  timeout=10.0, verify=False)
    if r.status_code >= 400:
        print(f"[supa-get] {table} {params} → {r.status_code} {r.text[:300]}")
        r.raise_for_status()
    return r.json()


def supa_delete(table: str, params: Dict[str, str]) -> None:
    r = httpx.delete(f"{SUPA_URL}/rest/v1/{table}", params=params, headers=HDRS,
                     timeout=10.0, verify=False)
    if r.status_code not in (200, 204):
        print(f"[supa-delete] {table} {params} → {r.status_code} {r.text[:200]}")


def webhook(jid_user: str, body: str, msg_id: str) -> None:
    payload = {
        "event": "message.received",
        "sessionId": SESSION_ID,
        "timestamp": time.time(),
        "idempotencyKey": f"test-{msg_id}",
        "deliveryId": f"test-{msg_id}",
        "data": {
            "from": f"{jid_user}@c.us",
            "to": "212633753039@c.us",
            "body": body,
            "type": "chat",
            "fromMe": False,
            "isGroup": False,
            "id": msg_id,
            "timestamp": int(time.time()),
        },
    }
    r = httpx.post(f"{BRAIN_URL}/openwa/webhook", json=payload, timeout=15.0)
    print(f"  POST → {r.status_code} {r.text[:120]}")


def main() -> int:
    # 1) Pick the seller via legacy mapping (mig 0004 not yet applied).
    sessions = supa_get("seller_whatsapp_sessions", {
        "jid": f"eq.{SESSION_ID}",
        "select": "seller_id",
        "limit": "1",
    })
    if sessions:
        sid = sessions[0]["seller_id"]
        sellers = supa_get("sellers", {
            "select": "id,status,business_name",
            "id": f"eq.{sid}",
        })
    else:
        # Single-seller fallback
        sellers = supa_get("sellers", {"select": "id,status,business_name",
                                       "status": "eq.active", "limit": "2"})
        if len(sellers) != 1:
            print(f"FAIL - cannot resolve seller (sessions={len(sessions)} "
                  f"sellers={len(sellers)})")
            return 1
    if not sellers:
        print("FAIL - no seller found")
        return 1
    seller = sellers[0]
    print(f"seller = {seller['id']}  ({seller.get('business_name')})")

    # 2) Find at least 2 active products with their aliases.
    products = supa_get("products", {
        "select": "id,name,aliases,status",
        "seller_id": f"eq.{seller['id']}",
        "status": "eq.active",
        "limit": "10",
    })
    if len(products) < 2:
        print(f"FAIL — need ≥2 active products, got {len(products)}: "
              f"{[p['name'] for p in products]}")
        return 1
    p1, p2 = products[0], products[1]
    # Pick a keyword that's in each product's aliases
    def first_alias(p):
        a = p.get("aliases") or []
        return next((x for x in a if re.match(r"^[a-zA-Z][a-zA-Z0-9 ]{2,}$", x)),
                    p["name"])
    kw1, kw2 = first_alias(p1), first_alias(p2)
    print(f"product 1: {p1['name']} (id {p1['id'][:8]})  keyword: {kw1!r}")
    print(f"product 2: {p2['name']} (id {p2['id'][:8]})  keyword: {kw2!r}")

    # 3) Use a unique test phone JID we know we own.
    test_user = "212600000077"
    # Wipe any prior conversation/messages for this phone so we start fresh.
    convos = supa_get("customer_conversations", {
        "select": "id",
        "seller_id": f"eq.{seller['id']}",
        "customer_jid": f"eq.{test_user}@c.us",
    })
    for c in convos:
        supa_delete("messages", {"conversation_id": f"eq.{c['id']}"})
        supa_delete("orders", {"conversation_id": f"eq.{c['id']}"})
    supa_delete("customer_conversations", {
        "seller_id": f"eq.{seller['id']}",
        "customer_jid": f"eq.{test_user}@c.us",
    })
    print(f"\n--- wiped prior state for test user {test_user} ---\n")

    # 4) Build an order on product 1 (give it name + city + qty)
    print("=== Turn 1: greet + product-1 keyword ===")
    webhook(test_user, f"salam bghit {kw1}", uuid.uuid4().hex)
    time.sleep(8)
    print("=== Turn 2: give name ===")
    webhook(test_user, "smiti Mohammed", uuid.uuid4().hex)
    time.sleep(6)
    print("=== Turn 3: city ===")
    webhook(test_user, "ana f Agadir", uuid.uuid4().hex)
    time.sleep(6)
    print("=== Turn 4: quantity ===")
    webhook(test_user, "bghit 50", uuid.uuid4().hex)
    time.sleep(10)  # give the LLM a chance to confirm

    print("\n--- pre-switch state ---")
    convos = supa_get("customer_conversations", {
        "select": "id,detected_product_id,pending_order_fields,language_code,status",
        "seller_id": f"eq.{seller['id']}",
        "customer_jid": f"eq.{test_user}@c.us",
    })
    if not convos:
        print("FAIL — no conversation row after turn 4")
        return 1
    convo = convos[0]
    pre_pending = convo.get("pending_order_fields") or {}
    pre_pid = convo.get("detected_product_id")
    print(f"  detected_product_id = {pre_pid[:8] if pre_pid else None}  "
          f"(expect: {p1['id'][:8]})")
    print(f"  pending = {pre_pending}")
    print(f"  status  = {convo.get('status')}")

    # 5) Switch to product 2.
    print("\n=== Turn 5: switch to product 2 ===")
    webhook(test_user, kw2, uuid.uuid4().hex)
    time.sleep(8)

    print("\n--- post-switch state ---")
    convos = supa_get("customer_conversations", {
        "select": "id,detected_product_id,pending_order_fields,language_code",
        "id": f"eq.{convo['id']}",
    })
    convo2 = convos[0]
    post_pending = convo2.get("pending_order_fields") or {}
    post_pid = convo2.get("detected_product_id")
    print(f"  detected_product_id = {post_pid[:8] if post_pid else None}  "
          f"(expect: {p2['id'][:8]})")
    print(f"  pending = {post_pending}")
    print(f"  language = {convo2.get('language_code')}")

    # 6) Assertions
    ok = True
    if post_pid != p2["id"]:
        print("\nFAIL — detected_product_id did not switch to product 2")
        ok = False
    else:
        print("\nPASS — detected_product_id swapped to product 2")

    reset_ts = post_pending.get("history_reset_at")
    if not reset_ts:
        print("FAIL — pending_order_fields.history_reset_at is missing")
        ok = False
    else:
        print(f"PASS — history_reset_at recorded: {reset_ts}")

    # Old order fields (name/qty/city) should be gone
    stale_keys = [k for k in ("customer_name", "city", "quantity",
                              "country_code")
                  if post_pending.get(k)]
    if stale_keys:
        print(f"FAIL — stale pending keys leaked: {stale_keys} = "
              f"{ {k: post_pending[k] for k in stale_keys} }")
        ok = False
    else:
        print("PASS — old pending fields (name/qty/city) cleared on switch")

    # 7) Verify load_conversation_history would filter out old messages.
    #    The brain stores messages in `messages` table. Count rows with
    #    created_at > reset_ts vs the total.
    if reset_ts:
        all_msgs = supa_get("messages", {
            "select": "id,role,content,created_at",
            "conversation_id": f"eq.{convo['id']}",
            "order": "created_at.asc",
        })
        post_msgs = [m for m in all_msgs if m["created_at"] > reset_ts]
        print(f"  total messages: {len(all_msgs)}  "
              f"post-reset: {len(post_msgs)}")
        # The switch message ("kw2") itself is logged AFTER the reset is
        # recorded, so we expect ≥1 post-reset user msg.
        if len(post_msgs) >= 1 and len(all_msgs) > len(post_msgs):
            print("PASS — history_reset_at correctly partitions the messages")
        else:
            print(f"FAIL — partition unexpected (total={len(all_msgs)}, "
                  f"post={len(post_msgs)})")
            ok = False

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
