# Cloud deploy marker — force Railway to ship the latest brain code:
#   • admin /funnel/admin/subscriptions* gated by _require_admin (Bearer token)
#   • seller writes (products/subscribe) honour FUNNEL_ALLOW_REMOTE in the cloud
"""leadecombot brain.py — Multi-tenant WhatsApp SaaS for e-commerce sellers.

Each incoming message arrives from the Baileys bridge with the seller_id
baked into the payload. This brain:

  1. Detects the customer's country from their JID phone-number prefix.
  2. On first contact, LLM-detects which of the seller's products the
     customer is asking about.
  3. Loads the per-(product × country) language + price + currency config.
  4. Replies in that language with a sales persona configured by the seller.
  5. Extracts order fields conversationally and pushes confirmed orders
     to the seller's Google Sheets webhook.

Data isolation: every Supabase query is filtered by seller_id; the brain
uses the service_role JWT to bypass RLS for writes.

Shares the OpenRouter API key with MediaHubAccess (the operator pays for
AI across all tenants).
"""

# Use the OS trust store on Windows so TLS works through any corporate
# proxy. Wrapped in a guarded import because `truststore.inject_into_ssl`
# has been observed to hang indefinitely on some Windows machines whose
# certificate store is in a weird state. Bypass via the env var
# LEADECOMBOT_SKIP_TRUSTSTORE=1 (also read from .env before any other
# import, because once truststore hangs we never get to load_dotenv).
import os as _os_early
import sys as _sys_early
_skip_truststore = bool(_os_early.environ.get("LEADECOMBOT_SKIP_TRUSTSTORE"))
if not _skip_truststore:
    # Light .env probe: look for the flag without pulling in dotenv yet.
    try:
        _here = _os_early.path.dirname(_os_early.path.abspath(__file__))
        _env_path = _os_early.path.join(_here, ".env")
        if _os_early.path.exists(_env_path):
            with open(_env_path, "r", encoding="utf-8") as _f:
                for _ln in _f:
                    _ln = _ln.strip()
                    if _ln.startswith("LEADECOMBOT_SKIP_TRUSTSTORE="):
                        _val = _ln.split("=", 1)[1].strip().strip('"').strip("'")
                        _skip_truststore = _val not in ("", "0", "false", "False", "no")
                        break
    except Exception:
        pass

if not _skip_truststore:
    # Run truststore.inject_into_ssl() in a thread with a hard timeout.
    # On some Windows boxes the Windows-cert-store enumeration call blocks
    # forever, so we bound the wait to 5 seconds and fall back to certifi
    # if the thread doesn't finish in time.
    import threading as _thr_early
    _trust_done = _thr_early.Event()
    def _do_trust():
        try:
            import truststore as _tr
            _tr.inject_into_ssl()
        except Exception as _trust_err:
            print(f"[startup] truststore failed: {_trust_err}", file=_sys_early.stderr)
        finally:
            _trust_done.set()
    _t = _thr_early.Thread(target=_do_trust, daemon=True)
    _t.start()
    if not _trust_done.wait(timeout=5):
        print("[startup] truststore.inject_into_ssl() didn't return in 5s — "
              "continuing with certifi fallback (proxy/MITM TLS may fail).",
              file=_sys_early.stderr)

# Even when truststore is skipped, httpx defaults to certifi. Set the env
# vars so every TLS-capable lib in the process picks up the same CA bundle.
try:
    import certifi as _certifi
    _ca = _certifi.where()
    _os_early.environ.setdefault("SSL_CERT_FILE", _ca)
    _os_early.environ.setdefault("REQUESTS_CA_BUNDLE", _ca)
except Exception:
    pass

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
from datetime import datetime, timezone
import urllib.parse
import uuid
from typing import Any, Dict, List, Optional, Tuple

import httpx
import phonenumbers
from dotenv import load_dotenv, dotenv_values
from flask import Flask, jsonify, request
from openai import OpenAI

load_dotenv()

# ── Shadow protection ────────────────────────────────────────────────────
# Windows User-level env vars can shadow .env values (load_dotenv doesn't
# override existing process env by default). For credentials, the project's
# .env is the source of truth — force it to win.
try:
    _env = dotenv_values()
    for _var in (
        "OPENROUTER_API_KEY", "OPENROUTER_MODEL",
        "SUPABASE_URL", "SUPABASE_SERVICE_KEY", "SUPABASE_ANON_KEY",
        "BRIDGE_SEND_URL",
        "OPENWA_API_URL", "OPENWA_API_KEY", "OPENWA_SESSION_ID",
    ):
        if _env.get(_var):
            os.environ[_var] = _env[_var]
except Exception:
    pass

# ── Configuration ────────────────────────────────────────────────────────
OPENROUTER_API_KEY    = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_BASE_URL   = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
DEFAULT_MODEL         = os.environ.get("OPENROUTER_MODEL", "openai/gpt-4o-mini")
PORT                  = int(os.environ.get("PORT", "5001"))
# Bind host. Railway's private network is IPv6, so in the cloud we bind "::"
# (dual-stack on Linux) — otherwise sibling services can't reach the brain.
# Plain "0.0.0.0" locally (unchanged). Override explicitly with HOST if needed.
HOST                  = os.environ.get(
    "HOST",
    "::" if (os.environ.get("RAILWAY_ENVIRONMENT") or os.environ.get("RAILWAY_PRIVATE_DOMAIN"))
    else "0.0.0.0",
)

SUPABASE_URL          = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_KEY  = os.environ.get("SUPABASE_SERVICE_KEY", "")
BRIDGE_SEND_URL       = os.environ.get("BRIDGE_SEND_URL", "http://localhost:3002/api/send")

# OpenWA gateway — the primary WhatsApp connection. Uses whatsapp-web.js +
# headless Chromium (real Chrome instance), which is much less likely to
# trip WhatsApp's anti-Baileys detection than the legacy bridge.
OPENWA_API_URL        = os.environ.get("OPENWA_API_URL", "http://localhost:2785").rstrip("/")
OPENWA_API_KEY        = os.environ.get("OPENWA_API_KEY", "")
OPENWA_SESSION_ID     = os.environ.get("OPENWA_SESSION_ID", "")

# Public base URL the brain is reachable at from the internet. External
# webhook sources (Shopify today) must be able to POST to us, so this is
# where we point the webhooks we register on the seller's behalf. In local
# dev this is localhost (Shopify can't reach it) — run a tunnel
# (ngrok / cloudflared) and set PUBLIC_BASE_URL to the public https URL so
# webhook auto-registration succeeds. When unset or localhost the connect
# endpoint still stores the integration and surfaces the webhook URL so the
# seller (or operator) can register it manually once a tunnel is up.
PUBLIC_BASE_URL       = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")

# Shopify Admin API version pinned for every call + webhook registration.
# Bump in lockstep with Shopify's deprecation calendar (each version is
# supported ~12 months).
SHOPIFY_API_VERSION   = os.environ.get("SHOPIFY_API_VERSION", "2024-10")

SESSIONS_FILE         = os.environ.get("SESSIONS_FILE", "sessions.json")
MAX_HISTORY_TURNS     = 20      # how many user+assistant turns to keep per conversation
# How many recent messages (NOT turns) to actually feed Agent 2 each call.
# The system prompt already carries an authoritative "COLLECTED SO FAR"
# summary of every captured field, so Agent 2 doesn't need the whole 40-msg
# transcript — the last ~7 turns are plenty for tone + immediate context.
# Cutting this is pure input-token savings on long conversations (Agent 2 =
# the expensive premium model) with no loss of remembered state.
AGENT2_HISTORY_MSGS   = 14

# ── AI cascade (unit-economics guard) ────────────────────────────────────
# The premium communicator model (e.g. gpt-5.1-chat — ~$10/M output tokens)
# is only worth its price on the moments that actually convert: the CLOSING
# turn and clearly hot leads. Every routine turn (greeting, FAQ, field
# collection) is answered by the cheap model. This cuts LLM cost ~4-5× per
# conversation and is what keeps margins POSITIVE at the $17–$34 price points
# (premium-on-every-turn costs more in tokens than the plan earns). It is also
# exactly the marketed behaviour: "premium AI on closing" / "full AI cascade".
# Set AI_CASCADE=0 to always use the configured model.
AI_CASCADE            = os.environ.get("AI_CASCADE", "1") not in ("0", "false", "False", "no")
CASCADE_CHEAP_MODEL   = os.environ.get("CASCADE_CHEAP_MODEL", "openai/gpt-4o-mini")

# Reasonable upper bound on an order quantity. A genuine retail customer
# orders 1-10 units. Anyone asking for hundreds or thousands is either
# joking, testing, or being abusive — the bot politely refuses instead
# of accepting "I want 100 000 000 bottles" as a valid order.
MAX_ORDER_QUANTITY    = 50

# Admin-tunable system settings live in this JSON file so the admin UI can
# update them at runtime without us touching .env or restarting the brain.
SYSTEM_SETTINGS_PATH  = os.path.join(os.path.dirname(__file__), "data", "system_settings.json")
try:
    os.makedirs(os.path.dirname(SYSTEM_SETTINGS_PATH), exist_ok=True)
except Exception:
    pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("brain")


# ── System-settings store ────────────────────────────────────────────────
# Tiny on-disk JSON file the admin UI writes to via /funnel/admin/settings.
# Reads are mtime-checked so other workers / restarts pick up changes
# without an explicit reload.
_system_settings: Dict[str, Any] = {}
_system_settings_mtime: float = 0.0

def _load_system_settings() -> Dict[str, Any]:
    global _system_settings, _system_settings_mtime
    try:
        mt = os.stat(SYSTEM_SETTINGS_PATH).st_mtime
        if mt != _system_settings_mtime:
            with open(SYSTEM_SETTINGS_PATH, "r", encoding="utf-8") as f:
                _system_settings = json.load(f) or {}
            _system_settings_mtime = mt
    except FileNotFoundError:
        _system_settings = {}
    except Exception as exc:
        log.warning("[settings] load failed: %s", exc)
    return _system_settings

def get_system_setting(key: str, env_default: str = "") -> str:
    """JSON file wins; .env value is the fallback so existing deployments
    keep working until the admin overrides anything."""
    s = _load_system_settings()
    v = s.get(key)
    if v not in (None, ""):
        return v
    return env_default

def set_system_setting(key: str, value: Optional[str]) -> None:
    """Write-through cache. Atomic via tmp + rename so a partial write
    can't corrupt the file."""
    global _system_settings, _system_settings_mtime
    s = dict(_load_system_settings())
    if value is None or value == "":
        s.pop(key, None)
    else:
        s[key] = value
    tmp = SYSTEM_SETTINGS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=2)
    os.replace(tmp, SYSTEM_SETTINGS_PATH)
    _system_settings = s
    try:
        _system_settings_mtime = os.stat(SYSTEM_SETTINGS_PATH).st_mtime
    except Exception:
        _system_settings_mtime = 0.0

def get_openrouter_key() -> str:
    return get_system_setting("openrouter_api_key", OPENROUTER_API_KEY)

def get_openrouter_model() -> str:
    return get_system_setting("openrouter_model", DEFAULT_MODEL)

# On some Windows boxes the truststore inject_into_ssl call hangs and
# httpx falls back to certifi, whose bundle doesn't include the corporate
# / MITM proxy roots. Both Supabase and OpenRouter calls then fail with
# SSL: CERTIFICATE_VERIFY_FAILED. For local dev the safe shortcut is to
# skip verification on these specific HTTPS calls. Production deployments
# should set SUPABASE_VERIFY_SSL=true.
_SUPA_VERIFY = (os.environ.get("SUPABASE_VERIFY_SSL", "false").lower()
                not in ("0", "false", "no", ""))

# The OpenAI client refuses an empty api_key at construction, so on first
# boot (before the operator pastes the OpenRouter key into .env) we pass
# a placeholder so the Flask app comes up. /webhook calls will still fail
# loudly with a 401 from OpenRouter, surfacing the missing-key state.
#
# Timeout tuned to 25s (was 60s): WhatsApp customers expect a reply in
# under ~15s, and a hung LLM call holding the bot silent for a full
# minute is worse than a fast fallback. 25s gives gpt-4o-mini room to
# stream a 250-token reply (typically ~3-8s) plus a generous buffer for
# OpenRouter latency spikes, while still failing fast on truly stuck
# requests.
_llm_http_client = httpx.Client(verify=_SUPA_VERIFY, timeout=25)
client = OpenAI(
    base_url=OPENROUTER_BASE_URL,
    api_key=OPENROUTER_API_KEY or "missing-paste-from-mediahubaccess-env",
    http_client=_llm_http_client,
)
app = Flask(__name__)


# ── Supabase REST helpers (service_role — bypasses RLS) ──────────────────
def _supa_headers() -> Dict[str, str]:
    return {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def _supa_get(table: str, params: Dict, timeout: float = 15) -> List[Dict]:
    """GET against the Supabase REST API. Returns a list (possibly empty)."""
    if not SUPABASE_SERVICE_KEY:
        log.warning("[supa] SUPABASE_SERVICE_KEY not set — returning empty list")
        return []
    try:
        r = httpx.get(
            f"{SUPABASE_URL}/rest/v1/{table}",
            params=params,
            headers=_supa_headers(),
            timeout=timeout,
            verify=_SUPA_VERIFY,
        )
        if r.status_code == 200:
            return r.json()
        # Quietly swallow "column does not exist" / "relation does not exist"
        # 400s — those are migration-state errors the caller is expected to
        # handle via fallback chains (e.g. the openwa_session_id lookup
        # before 0004 lands). Log everything else.
        body = r.text[:200] or ""
        is_schema_400 = r.status_code == 400 and (
            '"42703"' in body or 'does not exist' in body
        )
        if not is_schema_400:
            log.warning("[supa] GET %s → HTTP %s · %s", table, r.status_code, body)
        return []
    except Exception as exc:
        log.warning("[supa] GET %s exception: %s", table, exc)
        return []


def _supa_post(table: str, row: Dict, prefer: str = "return=representation") -> Optional[Dict]:
    """INSERT one row. Returns the inserted row (with id) or None."""
    if not SUPABASE_SERVICE_KEY:
        return None
    try:
        r = httpx.post(
            f"{SUPABASE_URL}/rest/v1/{table}",
            json=row,
            headers={**_supa_headers(), "Prefer": prefer},
            timeout=15,
            verify=_SUPA_VERIFY,
        )
        if r.status_code in (200, 201):
            data = r.json()
            return data[0] if isinstance(data, list) and data else data
        log.warning("[supa] POST %s → HTTP %s · %s", table, r.status_code, r.text[:200])
        return None
    except Exception as exc:
        log.warning("[supa] POST %s exception: %s", table, exc)
        return None


def _supa_patch(table: str, filter_eq: Dict[str, str], updates: Dict) -> bool:
    """PATCH rows matching the filter. Returns True on success."""
    if not SUPABASE_SERVICE_KEY:
        return False
    qs = "&".join(f"{k}=eq.{v}" for k, v in filter_eq.items())
    try:
        r = httpx.patch(
            f"{SUPABASE_URL}/rest/v1/{table}?{qs}",
            json=updates,
            headers={**_supa_headers(), "Prefer": "return=minimal"},
            timeout=15,
            verify=_SUPA_VERIFY,
        )
        return r.status_code in (200, 204)
    except Exception as exc:
        log.warning("[supa] PATCH %s exception: %s", table, exc)
        return False


def _supa_delete(table: str, filter_eq: Dict[str, str]) -> bool:
    """DELETE rows matching the filter. Returns True on success."""
    if not SUPABASE_SERVICE_KEY:
        return False
    qs = "&".join(f"{k}=eq.{v}" for k, v in filter_eq.items())
    try:
        r = httpx.delete(
            f"{SUPABASE_URL}/rest/v1/{table}?{qs}",
            headers={**_supa_headers(), "Prefer": "return=minimal"},
            timeout=15,
            verify=_SUPA_VERIFY,
        )
        return r.status_code in (200, 204)
    except Exception as exc:
        log.warning("[supa] DELETE %s exception: %s", table, exc)
        return False


# ── Seller / product / conversation lookups ──────────────────────────────
def fetch_seller(seller_id: str) -> Optional[Dict]:
    rows = _supa_get("sellers", {"id": f"eq.{seller_id}", "select": "*"})
    return rows[0] if rows else None


def list_seller_products(seller_id: str) -> List[Dict]:
    """Fetch the seller's active catalog. Tries the newest column set
    (sheets_webhook_url + price_tiers from migrations 0002 + 0003) first,
    falling back to older shapes so the bot keeps working even before the
    operator has applied the latest migration."""
    pc_full = "country_code,language_code,price,currency,price_tiers,translated_name,translated_description,available"
    pc_no_tiers = "country_code,language_code,price,currency,translated_name,translated_description,available"

    selects_to_try = [
        # Newest schema: 0012 adds custom_fields; 0008 kind; 0007 gallery_urls; 0006 whatsapp_session_ids.
        f"id,name,description,image_url,gallery_urls,aliases,whatsapp_session_ids,kind,custom_fields,sheets_webhook_url,product_countries({pc_full})",
        # 0012 not applied yet — drop custom_fields (brain falls back to built-in service flow).
        f"id,name,description,image_url,gallery_urls,aliases,whatsapp_session_ids,kind,sheets_webhook_url,product_countries({pc_full})",
        # 0008 not applied yet — drop kind (brain treats missing as 'product').
        f"id,name,description,image_url,gallery_urls,aliases,whatsapp_session_ids,sheets_webhook_url,product_countries({pc_full})",
        # 0007 not applied yet — drop gallery_urls.
        f"id,name,description,image_url,aliases,whatsapp_session_ids,sheets_webhook_url,product_countries({pc_full})",
        # 0006 not applied yet — also drop whatsapp_session_ids.
        f"id,name,description,image_url,aliases,sheets_webhook_url,product_countries({pc_full})",
        # No price_tiers yet (0003 not applied).
        f"id,name,description,image_url,aliases,sheets_webhook_url,product_countries({pc_no_tiers})",
        # No sheets_webhook_url either (0002 not applied).
        f"id,name,description,image_url,aliases,product_countries({pc_no_tiers})",
    ]
    for sel in selects_to_try:
        rows = _supa_get("products", {
            "seller_id": f"eq.{seller_id}",
            "status": "eq.active",
            "select": sel,
        })
        if rows:
            return rows
    return []


def get_or_create_conversation(seller_id: str, customer_jid: str,
                               country_code: str) -> Optional[Dict]:
    """Look up the conversation; if absent, create one. Returns the row dict."""
    existing = _supa_get("customer_conversations", {
        "seller_id": f"eq.{seller_id}",
        "customer_jid": f"eq.{customer_jid}",
        "select": "*",
        "limit": "1",
    })
    if existing:
        return existing[0]
    return _supa_post("customer_conversations", {
        "seller_id": seller_id,
        "customer_jid": customer_jid,
        "country_code": country_code,
    })


def load_conversation_history(conversation_id: str,
                              limit: int = MAX_HISTORY_TURNS,
                              since_iso: Optional[str] = None) -> List[Dict]:
    """Pull the last `limit` user+assistant turns for the LLM context.

    If `since_iso` is set (typically pending_order_fields.history_reset_at
    after a mid-conversation product switch), we ONLY return messages
    newer than that timestamp. This keeps the LLM from hallucinating
    details from the old product's flow into the new product's
    confirmation (e.g. carrying over "Mohammed wants 50 boxes at
    Agadir" when the customer switched to BioRein in Conakry)."""
    params = {
        "conversation_id": f"eq.{conversation_id}",
        "select": "role,content,created_at",
        "order": "created_at.desc",
        "limit": str(limit * 2),
    }
    if since_iso:
        params["created_at"] = f"gt.{since_iso}"
    rows = _supa_get("messages", params)
    # Supabase returns newest-first; reverse to chronological for the LLM.
    return list(reversed(rows))


def save_message(conversation_id: str, role: str, content: str) -> None:
    _supa_post("messages", {
        "conversation_id": conversation_id,
        "role": role,
        "content": content,
    })


# ── Country + language detection ─────────────────────────────────────────
def jid_is_lid(jid: str) -> bool:
    """WhatsApp 'Linked IDs' (used by Communities + the new privacy model)
    look like phone numbers but aren't — they're opaque identifiers. The
    digits before @lid must NEVER be fed to libphonenumber."""
    return bool(jid) and "@lid" in jid.lower()


def jid_to_phone(jid: str) -> str:
    """Strip Baileys' :device suffix and @-suffix. Returns '' for LIDs
    because their leading digits are not a real phone number."""
    if not jid:
        return ""
    if jid_is_lid(jid):
        return ""
    user = jid.split("@", 1)[0]
    user = user.split(":", 1)[0]
    # Baileys returns digits only; add the + sign for libphonenumber.
    return "+" + user if not user.startswith("+") else user


def phone_to_country(jid_or_phone: str) -> str:
    """Return ISO 3166-1 alpha-2 (e.g. 'MA', 'FR', 'GB') or '' on failure."""
    if "@" in jid_or_phone:
        if jid_is_lid(jid_or_phone):
            # @lid digits are opaque — parsing them gives garbage countries
            # (Mauritius for 230…, Ecuador for 593…, etc.).
            return ""
        phone = jid_to_phone(jid_or_phone)
    else:
        phone = jid_or_phone
    if not phone:
        return ""
    try:
        parsed = phonenumbers.parse(phone, None)
        cc = phonenumbers.region_code_for_number(parsed) or ""
        return cc.upper()
    except phonenumbers.NumberParseException:
        return ""


def snap_country_to_product(country_code: str, product: Optional[Dict]) -> str:
    """If we couldn't determine the customer's country (e.g. @lid JID with
    no senderPn) or the detected country isn't in the product's catalog,
    fall back to the product's single configured country. This is the
    correct behavior for single-market sellers: a Conakry-only product
    should always be priced/spoken-to in GN/French even when the JID
    parses to Mauritius."""
    if not product:
        return country_code
    pcs = product.get("product_countries") or []
    product_ccs = [
        (pc.get("country_code") or "").upper()
        for pc in pcs
        if pc.get("country_code")
    ]
    if not product_ccs:
        return country_code
    if country_code and country_code.upper() in product_ccs:
        return country_code.upper()
    # No match — use the first (and most often only) configured country.
    return product_ccs[0]


# ── Product detection ────────────────────────────────────────────────────
def _normalize_for_match(s: str) -> str:
    """Lowercase, strip accents-ish, collapse non-alphanumerics to spaces.
    Good enough for keyword matching against product names/aliases without
    pulling in a Unicode normalization dependency."""
    if not s:
        return ""
    s = s.lower()
    # Drop common diacritics for French/Arabic transliteration variants.
    replacements = str.maketrans({
        "à": "a", "â": "a", "ä": "a", "á": "a",
        "ç": "c",
        "é": "e", "è": "e", "ê": "e", "ë": "e",
        "î": "i", "ï": "i", "í": "i",
        "ô": "o", "ö": "o", "ó": "o",
        "ù": "u", "û": "u", "ü": "u", "ú": "u",
        "ñ": "n",
    })
    s = s.translate(replacements)
    s = re.sub(r"[^a-z0-9\s]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def detect_product_in_message(text: str, products: List[Dict]) -> Optional[Dict]:
    """Look at the customer's first message and return the product whose
    name (or any alias) appears as a whole word. Returns None if no
    product matches — the brain treats that as "stay silent" so random
    "hi" / "info?" pings to the seller's WhatsApp number don't trigger
    a sales pitch."""
    if not (text and products):
        return None
    norm_text = _normalize_for_match(text)
    if not norm_text:
        return None
    # Pad with spaces so we can use simple substring matching as a
    # whole-word check (the alternative — regex with \b — gets messy with
    # accented characters that we've already stripped).
    haystack = f" {norm_text} "

    best: Optional[Dict] = None
    best_score = 0
    for p in products:
        candidates = [p.get("name") or ""]
        candidates.extend(p.get("aliases") or [])
        # Also try translated product names so a French alias on the
        # product_countries row can trigger detection.
        for pc in p.get("product_countries") or []:
            if pc.get("translated_name"):
                candidates.append(pc["translated_name"])
        for cand in candidates:
            needle = _normalize_for_match(cand)
            if not needle or len(needle) < 3:
                continue
            if f" {needle} " in haystack:
                # Prefer longer matches (more specific). "biorein" beats
                # "bio" if both are aliases of different products.
                score = len(needle)
                if score > best_score:
                    best = p
                    best_score = score
                break
    return best


def filter_products_assigned_to_session(products: List[Dict],
                                        session_id: str) -> List[Dict]:
    """Return the subset of `products` whose `whatsapp_session_ids` list
    contains `session_id`. Used by process_inbound_message to default a
    product when the customer's first message doesn't name one explicitly.

    Products that haven't been pinned to any session (empty list) are
    NEVER returned here — they live in the "general pool" and are reached
    only via keyword detection. That way an inbound on bot12 (assigned to
    BioRein) does NOT also pick up unrelated catalog products as defaults.
    """
    if not (products and session_id):
        return []
    out: List[Dict] = []
    for p in products:
        ids = p.get("whatsapp_session_ids") or []
        # Defensive: column may be missing (pre-0006), or stored as a JSON
        # string. Normalize to a list of strings for the membership check.
        if isinstance(ids, str):
            try:
                ids = json.loads(ids) or []
            except Exception:
                ids = []
        if not isinstance(ids, list):
            continue
        if session_id in ids:
            out.append(p)
    return out


# Backwards-compatible alias kept for any callers still using the old name.
def llm_detect_product(text: str, products: List[Dict]) -> Optional[Dict]:
    return detect_product_in_message(text, products)


# Countries where French is the dominant business / e-commerce language.
# Used as a fallback so a Conakry (GN) customer is never replied to in
# English just because the seller forgot to add a product_countries row
# for GN or kept the seller-wide default at 'en'. The Maghreb (MA/DZ/TN)
# is intentionally excluded because those sellers commonly want Arabic.
FRANCOPHONE_COUNTRIES = frozenset({
    "FR", "BE", "LU", "MC", "HT",
    "GN", "CI", "SN", "ML", "BF", "TG", "BJ", "NE", "TD",
    "CM", "GA", "CG", "CD", "CF", "DJ",
    "MG", "KM", "RW", "BI",
})

LANGUAGE_NAMES = {
    "fr":  "French (Français)",
    "en":  "English",
    "ar":  "Arabic (العربية)",
    # Moroccan Darija written in ARABIC SCRIPT (الكتابة العربية).
    # This is the form most Moroccan shops now prefer on WhatsApp —
    # cleaner reading than Latin-Arabizi and feels more local. NOT MSA
    # Arabic: keep Darija vocabulary (بغيتي, شحال, واخا, خويا, عافاك, لاباس).
    "ary": (
        "Moroccan Darija written in Arabic script (الكتابة العربية). "
        "Use Darija vocabulary, NOT Modern Standard Arabic. Examples: "
        "'سلام خويا'، 'أهلان، لاباس؟'، 'سميتك عافاك؟'، 'فين ساكن؟'، "
        "'شحال بغيتي؟'، 'واخا، عطيني العنوان'، 'صافي، نوجدها ليك'. "
        "Do NOT switch to French; do NOT write in Latin/Arabizi (3,7,9); "
        "do NOT use formal MSA phrasing like 'كيف يمكنني مساعدتك'."
    ),
    "es":  "Spanish (Español)",
    "pt":  "Portuguese (Português)",
    "de":  "German (Deutsch)",
    "it":  "Italian (Italiano)",
}


def resolve_language(pc_language: str, stored_language: str,
                     seller_default: str, country_code: str,
                     sniffed_language: str = "") -> str:
    """Pick the reply language in this priority order:
       1. Conversation's **stored language** if already pinned — once we
          decided the chat is in Darija (or French, or any language),
          STAY in that language for the rest of the thread. Customers
          send mixed-language fillers all the time ("ok", "merci",
          "oui") and flipping the bot's reply tongue every turn felt
          like talking to two different agents.
       2. **Sniffed language from THIS message** — used only when the
          conversation has no stored language yet (first turn, or right
          after a product-switch reset). Strong signal customers like
          "salam khoya bghit X" land on the right language from the
          start.
       3. Per-product translation row's language.
       4. Francophone country fallback (GN, CI, SN, …).
       5. Seller's default_language.
       6. 'en'.

    Pre-2026-05 stage 1: pc_language won → Moroccans on a Conakry
    product got French replies despite writing in Darija.
    Pre-2026-05 stage 2: sniffed won every turn → bot flip-flopped
    fr↔ary mid-conversation as customer mixed languages.
    Current: stored wins once set, sniffed bootstraps from empty.
    """
    if stored_language:
        return stored_language.lower()
    if sniffed_language:
        return sniffed_language.lower()
    if pc_language:
        return pc_language.lower()
    cc = (country_code or "").upper()
    if cc in FRANCOPHONE_COUNTRIES:
        return "fr"
    return (seller_default or "en").lower()


# Tokens that strongly signal a particular language in a WhatsApp first
# message. Used by detect_message_language() to pick the reply language
# BEFORE we have a pinned product — so a customer who messages in Darija
# gets a Darija reply even when there's no product detected yet.
_DARIJA_TOKENS = (
    "bghit", "labass", "wakha", "khoya", "khti", "khouya",
    "smiyt", "ch7al", "chhal", "safi", "3afak", "3afk", "a3afak",
    "ahlan", "salam", "wach", "kayn", "kayne", "fin", "kifash",
    "nshallah", "inshallah", "bzaf", "shwiya", "mzn", "mezyan",
    "n9dr", "n9der", "n3ti", "n3tik", "siftha", "sift",
)
_FRENCH_TOKENS = (
    "bonjour", "salut", "merci", "svp", "stp", "combien",
    "je veux", "je voudrais", "j'ai", "c'est", "ça va",
    "comment", "pourquoi", "où", "qui", "quand", "quoi",
    "bonsoir", "bonne", "monsieur", "madame", "monsieur",
)
_ENGLISH_TOKENS = (
    "hello", "hi ", "hey", "how much", "i want", "i need",
    "please", "thanks", "thank you", "good morning", "good evening",
)


def detect_message_language(text: str) -> str:
    """Sniff the language the customer wrote in, from their message alone.
    Returns one of: 'ary' (Darija, Arabic or Latin), 'ar' (likely MSA),
    'fr', 'en', or '' if uncertain.

    Used when the bot has no pinned product yet and needs to pick a
    language for the initial greeting. Conservative: only returns a
    code when there's strong signal, so the seller's default language
    can still win for ambiguous one-word messages like \"ok\" / \"oui\".
    """
    if not text:
        return ""
    norm = text.lower().strip()
    # 1. Arabic-script content → Darija unless we have strong MSA signal.
    # Arabic Unicode range: U+0600..U+06FF. If even one Arabic char is
    # present, treat the message as Darija (Moroccan shops mostly).
    if any("؀" <= ch <= "ۿ" for ch in norm):
        return "ary"
    # 2. Latin-Arabizi Darija — common Darija tokens or 3/7/9 numerals
    # inside words ("3afak", "ch7al", "9bel").
    if any(t in norm for t in _DARIJA_TOKENS):
        return "ary"
    if re.search(r"\b\w*[379]\w+\b", norm):
        # Numerals embedded inside word characters are a strong Arabizi tell
        # (e.g. "n3ti", "ch7al", "9bel"). Phone numbers won't match because
        # they're pure digits — the `\w*` before the digit requires a letter.
        return "ary"
    # 3. French tokens.
    if any(t in norm for t in _FRENCH_TOKENS):
        return "fr"
    # 4. English.
    if any(t in norm for t in _ENGLISH_TOKENS):
        return "en"
    return ""


# ── Universal "Any Service" custom fields (migration 0012) ───────────────
# A kind='service' product can carry a seller-defined `custom_fields` array
# describing EXACTLY what the bot must extract before a booking is complete
# (e.g. car-rental: "type de voiture" + "nombre de jours"; clinic: "motif
# de consultation" + "date du rendez-vous"). This makes the extraction
# schema 100 % dynamic — no per-vertical code. Shape per entry (migration
# 0012): {key, label, type, required, is_standard}.
#
# When a service has NO custom_fields, the brain transparently falls back to
# its built-in service flow (name → service_date → city → address → notes),
# so nothing changes for sellers who never open the builder.
_CUSTOM_FIELD_TYPES = ("text", "phone", "number", "date", "choice")

# Minimal accent-folding map so a French/Arabic label still yields a usable
# snake_case key when the dashboard didn't pre-compute one.
_ACCENT_FOLD = str.maketrans({
    "à": "a", "â": "a", "ä": "a", "á": "a", "ã": "a",
    "é": "e", "è": "e", "ê": "e", "ë": "e",
    "î": "i", "ï": "i", "í": "i",
    "ô": "o", "ö": "o", "ó": "o", "õ": "o",
    "û": "u", "ü": "u", "ú": "u", "ù": "u",
    "ç": "c", "ñ": "n",
})


def _slugify_field_key(s: str) -> str:
    """Fold accents + lower-case + collapse non-alphanumerics to '_'. Returns
    a stable snake_case key (≤40 chars). May return '' for purely non-Latin
    labels (e.g. Arabic) — callers supply a positional fallback in that case."""
    s = (s or "").strip().lower().translate(_ACCENT_FOLD)
    s = re.sub(r"[^a-z0-9]+", "_", s).strip("_")
    return s[:40]


def normalize_custom_fields(product: Optional[Dict]) -> List[Dict]:
    """Return a product's custom_fields as a clean, ordered list of field
    definitions the brain can iterate over. Tolerates the two shapes a row
    might carry:
      • canonical array  [{key,label,type,required,is_standard}, ...]
      • legacy object map {"nom":"text", "date_entree":"date"} (the shape
        the original spec sketched) — converted on the fly.
    Drops blank/duplicate keys and the 'phone' key (phone always comes from
    the WhatsApp JID — the bot must NEVER ask for it). Returns [] for a
    missing / malformed / empty value, which signals "use the built-in
    service flow" to every caller."""
    raw = (product or {}).get("custom_fields")
    if not raw:
        return []
    if isinstance(raw, dict):                       # legacy {key: type}
        entries = [{"key": k, "label": k, "type": v if isinstance(v, str) else "text"}
                   for k, v in raw.items()]
    elif isinstance(raw, list):
        entries = [e for e in raw if isinstance(e, dict)]
    else:
        return []

    out: List[Dict] = []
    seen: set = set()
    for i, e in enumerate(entries):
        key = _slugify_field_key(e.get("key") or "") or _slugify_field_key(e.get("label") or "")
        if not key:
            key = f"field_{i + 1}"
        if key == "phone" or key in seen:
            continue
        ftype = str(e.get("type") or "text").lower()
        if ftype not in _CUSTOM_FIELD_TYPES:
            ftype = "text"
        label = (str(e.get("label") or "").strip()) or key
        out.append({
            "key": key,
            "label": label,
            "type": ftype,
            # Default required=True — the whole point is "don't confirm until
            # the field list is complete". Sellers opt fields OUT explicitly.
            "required": bool(e.get("required", True)),
            "is_standard": bool(e.get("is_standard", False)),
        })
        seen.add(key)
    return out


def _sanitize_custom_fields_for_storage(raw) -> List[Dict]:
    """Validate + clean a custom_fields array coming from the dashboard
    before persisting. Unlike normalize_custom_fields (the RUNTIME view,
    which drops 'phone' because the bot never asks for it), this KEEPS every
    field the seller configured — including the Téléphone toggle — so the
    editor round-trips exactly what the user set. Enforces the field shape,
    stable snake_case keys, and de-duplication."""
    if not isinstance(raw, list):
        return []
    out: List[Dict] = []
    seen: set = set()
    for i, e in enumerate(raw):
        if not isinstance(e, dict):
            continue
        key = (_slugify_field_key(str(e.get("key") or ""))
               or _slugify_field_key(str(e.get("label") or ""))
               or f"field_{i + 1}")
        if key in seen:
            continue
        ftype = str(e.get("type") or "text").lower()
        if ftype not in _CUSTOM_FIELD_TYPES:
            ftype = "text"
        out.append({
            "key": key,
            "label": (str(e.get("label") or "").strip()) or key,
            "type": ftype,
            "required": bool(e.get("required", True)),
            "is_standard": bool(e.get("is_standard", False)),
        })
        seen.add(key)
    return out


def _ask_instruction_for_field(field: Dict) -> str:
    """Type-aware NEXT-ACTION instruction telling the LLM to collect ONE
    custom field this turn, in the customer's language, WhatsApp-casual."""
    label = field.get("label") or field.get("key") or "the detail"
    ftype = field.get("type") or "text"
    base = (f"Ask the customer for: \"{label}\". ONE short, natural, "
            f"WhatsApp-casual question — nothing else this turn. ")
    if ftype == "date":
        return base + ("This is a DATE/TIME. Accept relative answers "
                       "('demain', 'vendredi', 'غدا', '15 juin') as-is — "
                       "do NOT demand a YYYY-MM-DD format.")
    if ftype == "number":
        return base + ("This is a NUMBER (a count / quantity / duration). "
                       "If the customer replies with a bare number, that IS "
                       "the answer.")
    if ftype == "choice":
        return base + ("Let the customer answer in their own words — don't "
                       "force a rigid menu unless the service context lists "
                       "specific options.")
    if ftype == "phone":  # defensive — normalize drops 'phone', but be safe
        return base + ("Only if the WhatsApp number isn't the right contact.")
    return base + "Keep it light and human."


def _custom_fields_prompt_block(fields: List[Dict]) -> str:
    """Render the seller-defined extraction schema as a prompt section the
    LLM follows: an ordered checklist of fields to collect, each with a
    human label + a type hint, plus the hard GATE that confirmation is
    forbidden until every required field is filled. This is the universal
    Prompt-Generator output that makes the bot work for ANY service."""
    type_hint = {
        "text":   "free text",
        "phone":  "phone number",
        "number": "a number",
        "date":   "a date/time — accept 'demain', 'vendredi', 'غدا' as-is",
        "choice": "let them answer in their own words",
    }
    lines = ["DETAILS TO COLLECT FOR THIS BOOKING (ask ONE at a time, in this "
             "order, the natural WhatsApp-casual way — never dump the whole "
             "list in one message):"]
    for i, f in enumerate(fields, 1):
        req = "REQUIRED" if f.get("required", True) else "optional"
        lines.append(
            f"  {i}. {f['label']}  →  store it under the key `{f['key']}`  "
            f"[{type_hint.get(f['type'], 'free text')} · {req}]"
        )
    lines.append(
        "GATE (critical): do NOT recap or ask for confirmation until EVERY "
        "field marked REQUIRED above has a value. While one is still missing, "
        "your only goal this turn is to naturally collect the next missing "
        "one. Optional fields never block confirmation — capture them only if "
        "the customer volunteers the information."
    )
    return "\n".join(lines)


def _custom_fields_next_stage(pending: Dict, history_len: int,
                              fields: List[Dict]) -> Tuple[str, str]:
    """Dynamic stage machine for a service that carries a seller-defined
    custom_fields schema: greet → ask each REQUIRED + missing field in the
    seller's order → confirm. Optional fields never gate the flow (the bot
    may still pick them up opportunistically from what the customer says),
    so the booking can't get stuck waiting on a 'nice to have'."""
    if history_len == 0:
        return ("STAGE 1 — greet (service)",
                "Short, warm greeting + ask how they're doing. ~1 short "
                "sentence. Examples: \"Bonjour 👋 Ça va ?\" / "
                "\"سلام 😊 لاباس؟\". Do NOT mention the service, the price, "
                "or ask anything yet.")
    for f in fields:
        if not f.get("required", True):
            continue
        if not pending.get(f["key"]):
            return (f"STAGE — collect «{f['label']}»",
                    _ask_instruction_for_field(f))
    collected_labels = ", ".join(f["label"] for f in fields if pending.get(f["key"]))
    return ("STAGE — confirm the booking",
            "All required details are collected. Recap the booking in ONE "
            "clean line using what you gathered"
            + (f" ({collected_labels})" if collected_labels else "")
            + ", slip the rate in if not already mentioned, and ask for "
            "explicit confirmation. Examples: \"Je confirme votre "
            "réservation ?\" / \"نأكد الحجز؟\". Keep under 240 chars. Zero "
            "extra questions — the customer just needs to say oui / "
            "yes / 3afak.")


def _service_next_stage(pending: Dict, history_len: int) -> Tuple[str, str]:
    """Stage machine for kind='service' products (bookings, rentals,
    appointments). Field order: name → service_date → city → address →
    notes (optional) → confirm.

    Notes (free-text "anything else?") is the catch-all where customers
    pin down rental specifics (car type, duration in days) or service
    specifics (urgent leak vs scheduled visit) without us having to model
    each vertical separately. Sellers who want strict structured fields
    can move to the future custom-fields builder.
    """
    has_name        = bool(pending.get("name"))
    has_service_dt  = bool(pending.get("service_date"))
    has_city        = bool(pending.get("city"))
    has_address     = bool(pending.get("address"))
    has_notes       = bool(pending.get("notes"))

    if history_len == 0:
        return ("STAGE 1 — greet (service)",
                "Short, warm greeting + ask how they're doing. ~1 short "
                "sentence. Examples: \"Bonjour 👋 Ça va ?\" / "
                "\"سلام 😊 لاباس؟\". Do NOT mention the service, the "
                "price, or ask anything yet.")
    if not has_name:
        return ("STAGE 2 — ask name casually (service)",
                "Quick acknowledgement + ask their name. Examples: "
                "\"Super, vous vous appelez comment ?\" / "
                "\"واخا 😊 سميتك عافاك؟\". Nothing else this turn.")
    if not has_service_dt:
        return ("STAGE 3 — ask the booking date casually",
                "Ask WHEN they need the service in 1 short, natural "
                "phrase. Examples in FR: \"Vous le voulez pour quand ?\" / "
                "\"C'est pour quel jour ?\" / \"Vous comptez en avoir "
                "besoin quand ?\". In Darija: \"إمتى بغيتيها؟\" / "
                "\"شنو هو النهار لي بغيتي؟\". Accept relative answers "
                "like \"demain\", \"vendredi\", \"غدا\", \"السبت\" — "
                "store as-is. Do NOT demand a YYYY-MM-DD format.")
    if not has_city:
        return ("STAGE 4 — ask city casually (service)",
                "Ask which city / zone they're in (so we know if we can "
                "service them). Examples: \"Vous êtes dans quelle "
                "ville ?\" / \"فين ساكن؟\". Nothing else.")
    if not has_address:
        return ("STAGE 4b — ask precise address (service)",
                "Ask for the full address / pickup point in 1 short "
                "phrase. Examples: \"L'adresse exacte ?\" / \"وين "
                "بالضبط؟\". For a rental this is where we deliver. "
                "Nothing else.")
    if not has_notes:
        return ("STAGE 5 — ask for extra details + slip in the rate",
                "Ask if there are any specifics we should know — for a "
                "rental: which model + how many days; for a haircut: "
                "the style; for a service visit: what's wrong. Slip "
                "the rate in casually. Examples: \"Quel modèle vous "
                "intéresse et pour combien de jours ? (Notre tarif "
                "c'est X par jour)\" / \"شنو بغيتي بالضبط؟ (التعريفة "
                "ديالنا هي X)\". One short message.")
    return ("STAGE 6 — confirm the booking",
            "Recap the booking in ONE clean line and ask for explicit "
            "confirmation. Format: \"Donc pour {name} : {service_name} "
            "le {service_date}, à {address} ({city}). {notes}. "
            "Je confirme votre réservation ?\". Keep under 240 chars. "
            "Zero extra questions. The customer just needs to say "
            "oui/yes/oui ok/3afak.")


def determine_next_stage(pending: Dict, history_len: int,
                         order_placed: bool = False,
                         kind: str = "product",
                         custom_fields: Optional[List[Dict]] = None) -> Tuple[str, str]:
    """Figure out which sales stage the conversation is in, based on what
    fields we've already collected and how many turns have gone by.

    `kind` controls the field sequence:
      • 'product' (default — e-commerce goods): name → city → address →
        quantity → confirm. Bot quotes unit price + total.
      • 'service' (rental cars, haircuts, plumbing, catering, any
        booking): name → service_date → city → address → notes →
        confirm. Bot quotes the listed rate but never asks for a unit
        count — services are inherently "1 booking".

    Returns (stage_label, next_action_instruction) for the system prompt.
    Stages are deterministic — the LLM only has to execute the next step
    rather than re-derive the whole flow from message history.

    `order_placed=True` short-circuits to STAGE 6: the customer has
    already confirmed and the booking/order is in the seller's sheet, so
    the bot must stop summarizing/asking-to-confirm and just acknowledge
    any follow-up messages warmly without creating a second entry.
    """
    booking_word = "booking" if kind == "service" else "order"
    if order_placed:
        return (f"STAGE 6 — {booking_word} already placed, acknowledge only",
                f"The {booking_word} has already been placed and saved. DO NOT "
                f"summarize the {booking_word} again, DO NOT ask the customer to "
                "confirm anything, and DO NOT add new questions about "
                f"the {booking_word}. Just respond warmly and briefly to whatever "
                "the customer says (thank them, answer any follow-up "
                "question about timing / arrival, etc.). If they want to "
                f"modify or place an additional {booking_word}, tell them you'll "
                "have a human follow up shortly.")

    # Service flow has its own stage machine. A seller-defined custom_fields
    # schema (migration 0012) takes precedence over the built-in field order.
    if kind == "service":
        if custom_fields:
            return _custom_fields_next_stage(pending, history_len, custom_fields)
        return _service_next_stage(pending, history_len)

    has_name = bool(pending.get("name"))
    has_city = bool(pending.get("city"))
    has_address = bool(pending.get("address"))
    has_quantity = bool(pending.get("quantity"))

    if history_len == 0:
        return ("STAGE 1 — greet",
                "Short, warm greeting + ask how they're doing. ~1 short "
                "sentence. Examples: \"Bonjour 👋 Ça va ?\" or "
                "\"Salut ! Comment ça va ?\". Do NOT mention the product, "
                "price, or ask anything else.")
    if not has_name and not has_city:
        return ("STAGE 2/3 — react + ask name casually",
                "Reply with a quick acknowledgement (1 short phrase, not a "
                "sales pitch), then casually ask their name. Examples: "
                "\"Super ! Vous vous appelez comment ?\", "
                "\"Ah parfait 😊 C'est à quel nom ?\". "
                "Do NOT explain the product, do NOT mention price.")
    if not has_name:
        return ("STAGE 3 — ask name casually",
                "Ask for their name in 1 short, natural phrase. Examples: "
                "\"Vous vous appelez comment ?\", \"C'est à quel nom ?\". "
                "Nothing else this turn.")
    if not has_city:
        return ("STAGE 3 — ask city casually",
                "Ask for their delivery city or neighborhood in 1 short "
                "phrase. Examples: \"Et vous habitez où ?\", "
                "\"Vous êtes dans quelle ville ?\". Nothing else.")
    if not has_quantity:
        return ("STAGE 4 — ask quantity + slip in price",
                "Ask in 1 short sentence how many units, and mention the "
                "unit price casually. Examples: "
                "\"Combien vous voulez ? (299 000 GNF la bouteille)\", "
                "\"Vous voulez combien ? La bouteille c'est 299 000 GNF.\". "
                "If the customer replies just \"1\" or \"2\", that IS the "
                "quantity.")
    if not has_address:
        return ("STAGE 4b — ask street address casually",
                "Ask for the full street address in 1 short phrase. Examples: "
                "\"Et l'adresse exacte ?\", \"Vous habitez où précisément ?\". "
                "Nothing else.")
    return ("STAGE 5 — confirm casually",
            "Summarize the order in 1 SHORT message and ask for "
            "confirmation. Format like: \"Donc {qty} {product} pour "
            "{name}, livraison à {city}, {address}. Total {total} {currency}. "
            "Je valide ?\". Keep it under 220 chars. NO extra questions.")


def _pending_summary(pending: Dict, phone_from_jid: str,
                     kind: str = "product",
                     custom_fields: Optional[List[Dict]] = None) -> str:
    """Short bullet list of what we already know, for the prompt.
    Field set depends on `kind` so the bot's COLLECTED block always
    matches what its stage machine actually expects to fill in. When the
    service carries a seller-defined custom_fields schema, the bullet list
    is built from THOSE fields (migration 0012).
    """
    rows = []
    if phone_from_jid:
        rows.append(f"  • Phone: {phone_from_jid} (from WhatsApp — already on file, NEVER ask)")
    if kind == "service" and custom_fields:
        labels = [(f["label"] + ("" if f.get("required", True) else " (optional)"),
                   f["key"]) for f in custom_fields]
    elif kind == "service":
        labels = (("Name", "name"),
                  ("Service date", "service_date"),
                  ("City", "city"),
                  ("Address", "address"),
                  ("Notes / specifics", "notes"))
    else:
        labels = (("Name", "name"),
                  ("City", "city"),
                  ("Address", "address"),
                  ("Quantity", "quantity"))
    for label, key in labels:
        v = pending.get(key)
        if v:
            rows.append(f"  • {label}: {v}")
        else:
            rows.append(f"  • {label}: (missing — collect when the flow reaches it)")
    return "\n".join(rows) if rows else "  (nothing yet)"


# Valid `sellers.business_category` values. Must stay in lock-step with the
# CHECK constraint (migrations 0009 + 0013) and the dashboard's vertical
# selector. The first eight are the original 0009 set; the last three were
# added in 0013 for the African market (car rental is huge there). The
# dashboard maps these onto ServiceTypes for its dynamic UI; the brain maps
# them onto CATEGORY_GUIDANCE for the bot's data-collection script.
VALID_BUSINESS_CATEGORIES = {
    "e_commerce", "restaurant", "beauty_salon", "real_estate",
    "health_clinic", "education", "professional_services", "other",
    "car_rental", "hotel", "travel_agency",
}


_PHOTO_REQUEST_RX = re.compile(
    r"\b(photos?|fotos?|images?|pics?|picture)\b"
    r"|tsaw[ae]r|tas?wir|tswira|swira|souwar|\bsowar\b|\bsora\b"
    r"|montre[rz]?\b|wre?ini|warini"
    r"|صور|صورة|تصاو[ير]|ورّ?يني",
    re.IGNORECASE,
)


def _wants_photos(text: str) -> bool:
    """True when the customer is asking to SEE the product — photos /
    pictures / «tsawr» / «صور» / «montre-moi» / «wreeni». Liberal on
    purpose: sending a saved product photo is low-cost and is exactly what
    they asked for."""
    if not text:
        return False
    return bool(_PHOTO_REQUEST_RX.search(text))


def build_system_prompt(seller: Dict, product: Dict, pc: Optional[Dict],
                        language: str, country_code: str = "",
                        pending: Optional[Dict] = None,
                        history_len: int = 0,
                        phone_from_jid: str = "",
                        order_placed: bool = False,
                        kind: str = "product",
                        agent1_closing_block: str = "",
                        photo_note: str = "") -> str:
    """Compose the per-conversation system prompt.

    Enforces a staged sales flow (greet → small-talk → interest → name+city
    → price → confirm) so the bot never dumps the full product card on
    first contact. The language directive is placed at the very top with a
    hard lock so the seller's English-language persona can't drag replies
    back into English when the customer is francophone.

    A "COLLECTED SO FAR" + "NEXT ACTION" block is injected each turn so
    the LLM knows what's already been gathered and what's left — without
    this, the LLM keeps re-asking questions whose answers are buried in
    the message history.
    """
    pending = pending or {}
    # Seller-defined extraction schema for this service (migration 0012).
    # Empty for products and for services that never opened the builder —
    # in which case every downstream branch keeps its built-in behaviour.
    custom_fields = normalize_custom_fields(product) if kind == "service" else []
    persona = (seller.get("bot_persona") or "").replace(
        "{{business_name}}", seller.get("business_name") or "the shop"
    ).strip()

    # SaaS personalization layer (migration 0009). business_category +
    # tone_of_voice drive the persona block below — they replace what
    # used to be a single hardcoded "Confirmatrice Pro Pro" archetype.
    # Both are optional: when null, defaults to e_commerce + friendly,
    # which matches the pre-0009 behavior exactly.
    business_category = (seller.get("business_category") or "e_commerce").lower()
    tone_of_voice = (seller.get("tone_of_voice") or "friendly").lower()
    CATEGORY_GUIDANCE = {
        "e_commerce":
            "You sell physical products. Collect name → city → address → "
            "quantity, then close with a clear order recap and total. "
            "Free delivery, cash on delivery is the default unless the "
            "PRODUCT block says otherwise.",
        "restaurant":
            "You take restaurant reservations / orders. Collect name → "
            "people count → date/time → dish or pre-order → city/address "
            "for delivery (if applicable). NEVER ask 'how many units' — "
            "ask 'how many people' or 'which dish'.",
        "beauty_salon":
            "You book beauty / hair appointments. Collect name → service "
            "(haircut, color, manicure, etc.) → preferred date/time → "
            "stylist preference (optional). Mention duration if known.",
        "real_estate":
            "You handle real-estate leads. Collect name → buy or rent → "
            "property type (apt/house/villa) → city/zone → budget range → "
            "bedroom count. Promise a callback from a human agent at the "
            "end — never close a deal yourself.",
        "health_clinic":
            "You book medical / health-clinic consultations. Collect name "
            "→ reason for the visit (kept brief, no diagnosis chat) → "
            "preferred date/time → city. NEVER give medical advice. "
            "Escalate to a human if the customer describes symptoms.",
        "education":
            "You handle education / training enrollment leads. Collect "
            "name → course or level of interest → preferred start date → "
            "city/online preference → contact callback time.",
        "professional_services":
            "You handle freelance / agency / service leads (consulting, "
            "legal, marketing, etc.). Collect name → service need → "
            "budget range (optional) → preferred callback time → city.",
        "car_rental":
            "You book car rentals. Collect name → vehicle type (city car, "
            "SUV, van, luxury…) → pick-up date → return date → pick-up city/"
            "location. Quote the daily rate × number of days. Mention "
            "whether a deposit / driver's licence is required if known.",
        "hotel":
            "You take hotel bookings. Collect name → room type (single, "
            "double, suite…) → check-in date → check-out date → number of "
            "guests. Quote nightly rate × number of nights. Confirm "
            "breakfast / amenities if the ROOM block mentions them.",
        "travel_agency":
            "You sell trips / travel packages. Collect name → destination → "
            "departure date → number of travelers → trip type (flight only, "
            "package, organised tour…). Promise a human travel agent will "
            "confirm availability and final pricing.",
        "other":
            "You handle generic inquiries. Collect name → city → free-form "
            "request details → preferred callback time. Promise a human "
            "follow-up at the end.",
    }
    category_block = CATEGORY_GUIDANCE.get(business_category,
                                            CATEGORY_GUIDANCE["e_commerce"])

    TONE_GUIDANCE = {
        "professional":
            "Tone: formal and precise. Use 'vous' / Modern Standard Arabic. "
            "No emoji. Short sentences. No banter.",
        "friendly":
            "Tone: warm, casual, light. ONE emoji per chat-mode reply is "
            "fine. Match the customer's energy — playful with playful, "
            "calm with hesitant.",
        "persuasive":
            "Tone: confident, energetic, slightly sales-forward. Drop "
            "natural urgency cues ('on a un super lot ce mois-ci', 'stock "
            "limité'). Never pushy or aggressive. One emoji max.",
    }
    tone_block = TONE_GUIDANCE.get(tone_of_voice, TONE_GUIDANCE["friendly"])

    lang_label = LANGUAGE_NAMES.get(language, language or "the customer's language")

    name = (pc or {}).get("translated_name") or (product or {}).get("name") or ""
    desc = (pc or {}).get("translated_description") or (product or {}).get("description") or ""
    price = (pc or {}).get("price")
    currency = (pc or {}).get("currency") or ""
    price_line = f"{price} {currency}" if (price and currency) else ""
    product_for_flow = name or "the product"

    sections = []

    # Category + tone (migration 0009) — injected first so the model
    # frames the rest of the prompt through this lens. The original
    # Confirmatrice Pro Pro block below still applies; category +
    # tone just refine the data-collection sequence and the warmth.
    sections.append(
        "╔═══ BUSINESS CONTEXT (set by seller in AI Agent Wizard) ═══╗\n"
        f"Business category: {business_category}\n"
        f"  → {category_block}\n\n"
        f"Tone of voice: {tone_of_voice}\n"
        f"  → {tone_block}"
    )

    sections.append(
        "╔═══ WHO YOU ARE — Confirmatrice Pro Pro ═══╗\n"
        "You are a Confirmatrice Pro Pro — an elite professional order-\n"
        "confirmation agent for an e-commerce shop in Morocco. You are NOT\n"
        "a chatbot, NOT a generic assistant, NOT ChatGPT. You are the\n"
        "shop's BEST sales agent — the one the owner trusts with their\n"
        "most valuable leads. Every conversation = one chance to close.\n\n"
        "YOUR JOB (in order):\n"
        "  1. Greet warmly and put the customer at ease in ONE short line.\n"
        "  2. Listen carefully to what they say — read EVERY prior turn in\n"
        "     the chat history before replying. Never repeat a question\n"
        "     whose answer is already on file.\n"
        "  3. Answer ANY product question clearly and briefly using ONLY\n"
        "     the PRODUCT block below as your source of truth.\n"
        "  4. Gather the 3 missing fields needed to ship: name → city/\n"
        "     address → quantity. (Phone is already on file — NEVER ask.)\n"
        "  5. Quote the price + total at Stage 4 (or earlier if the\n"
        "     customer ASKS the price first — customer-driven reveal is\n"
        "     always allowed).\n"
        "  6. Recap the order in ONE clean line + ask for explicit\n"
        "     confirmation: 'Je confirme votre commande ?' / 'نأكد الطلب؟'.\n"
        "  7. After confirmation: thank them warmly, give the delivery\n"
        "     ETA (24-48h, cash on delivery, free delivery), close.\n\n"
        "PROFESSIONAL STANDARDS (these define 'Pro Pro' — zero exceptions):\n"
        "  • EVERY reply must be useful. No filler, no 'is there anything\n"
        "    else I can help with' — you know exactly what the next step\n"
        "    is, take it.\n"
        "  • EVERY reply must reference the chat context. If the customer\n"
        "    said 'mon mari aussi en veut', acknowledge that ('ah génial,\n"
        "    pour deux alors?'). If they hesitated earlier, reassure them\n"
        "    now. Never reply as if the conversation just started.\n"
        "  • NEVER admit you're an AI or a bot. If asked directly say\n"
        "    you're the shop's order-confirmation assistant. Period.\n"
        "  • NEVER apologize more than once per conversation. Pros don't\n"
        "    grovel — they course-correct and move on.\n"
        "  • NEVER end a reply on a dead-end. Every reply moves the order\n"
        "    forward by ONE concrete step.\n"
        "  • Tone: confident, friendly, light — but ZERO sloppy emoji\n"
        "    spam, ZERO baby-talk, ZERO 'hihihi'. One emoji per chat-mode\n"
        "    reply max, ZERO emoji in confirmation mode.\n\n"
        "TRUTH RULES (zero exceptions):\n"
        "  • Never invent product facts, ingredients, certifications, or\n"
        "    medical claims that are not in the PRODUCT block below. If\n"
        "    the customer asks something you don't know, say honestly:\n"
        "    'Je vérifie ce point avec le pharmacien et je vous reviens,\n"
        "    en attendant on peut finaliser le reste ?' and move on.\n"
        "  • Never invent a price. Use ONLY the unit price + bulk offers\n"
        "    in the PRODUCT block. Never round up. Never improvise a\n"
        "    discount.\n"
        "  • Never invent delivery promises beyond '24-48h, free delivery,\n"
        "    cash on delivery' unless the PRODUCT block says otherwise.\n"
        "  • Never quote a payment link, bank transfer, or anything other\n"
        "    than cash-on-delivery — that's how this shop operates.\n"
        "  • Stay strictly inside the role: do NOT discuss politics,\n"
        "    religion, other brands, your own opinion on anything. If\n"
        "    they go off-topic, gently bring them back: 'Haha, en tout\n"
        "    cas pour la commande... ?'\n\n"
        "ESCALATION RULES (handoff signals):\n"
        "  • Customer is angry / explicitly says 'I want a human' →\n"
        "    'Je transmets à mon collègue, il vous rappelle dans la\n"
        "    journée.' Do NOT keep pushing the order.\n"
        "  • Customer asks something legally sensitive (medical advice,\n"
        "    dosage for a specific condition, allergy interactions) →\n"
        "    same handoff line.\n"
        "  • Customer wants a quantity above 50 → refuse politely, ask\n"
        "    how many they REALLY want, do NOT push.\n\n"
        "╔═══ LANGUAGE LOCK ═══╗\n"
        f"You MUST reply ONLY in {lang_label}. Period. This is the #1 rule.\n"
        f"  • Ignore the language of any previous assistant messages in this "
        f"chat history — if they were in English by mistake, switch to "
        f"{lang_label} starting from THIS reply.\n"
        f"  • Ignore the language of the customer's message — even if they "
        f"write in English, Arabic, or anything else, your reply stays in "
        f"{lang_label}.\n"
        f"  • Ignore any English text in your persona or product description "
        f"below — those are context for you, not language hints.\n"
        f"Every single word you output must be in {lang_label}. No exceptions."
    )

    if persona:
        sections.append(f"PERSONA:\n{persona}")

    if name:
        if kind == "service":
            offering_label = "SERVICE YOU ARE BOOKING FOR THE CUSTOMER"
            price_descriptor = (
                f"Rate (reveal at STAGE 5 only, when asking for details): "
                f"{price_line}." if price_line else ""
            )
        else:
            offering_label = "PRODUCT YOU ARE SELLING"
            price_descriptor = (
                f"Unit price (reveal at STAGE 4 only): {price_line}, "
                "free delivery." if price_line else ""
            )
        product_lines = [f"{offering_label}: {name}"]
        if desc:
            if kind == "service":
                # For services the description IS the seller's "Contexte
                # Global & Instructions de l'IA" — authoritative guidance on
                # how to talk about the service, what's included, conditions,
                # etc. Treat it as your knowledge base for this service.
                product_lines.append(
                    "SERVICE CONTEXT & INSTRUCTIONS (authoritative — this is "
                    "what you know about the service; follow it, answer "
                    "questions from it, don't contradict it):\n" + desc)
            else:
                product_lines.append(f"Description (for your own context — do not paste verbatim): {desc}")
        if price_descriptor:
            product_lines.append(price_descriptor)
        tier_block = _format_tier_offers(pc, product)
        if tier_block and kind != "service":
            # Tiered pricing is e-com specific (buy 3 get 1 free etc).
            # Services use a flat rate + extras the customer describes.
            product_lines.append(
                "Bulk offers (reveal at STAGE 4 only — quote the exact "
                "total for the customer's quantity, and gently mention the "
                "next better tier if it would save them money):\n" + tier_block
            )
        if kind == "service":
            multi_unit_hint = (
                "    need multi-day / multi-unit (e.g. 3 days car rental), "
                "    capture that in the matching detail field below.\n"
                if custom_fields else
                "    need multi-day / multi-unit (e.g. 3 days car rental), "
                "    capture that in NOTES, not in a quantity field.\n"
            )
            product_lines.append(
                "BOOKING MODE (not a physical product order):\n"
                "  • You are taking a BOOKING / RESERVATION / APPOINTMENT, "
                "    NOT shipping a physical product. Never ask 'how "
                "    many' — services are 1 booking by default. If they "
                + multi_unit_hint +
                "  • Never promise delivery — the customer comes to you "
                "    OR you go to them depending on the service.\n"
                "  • Date fields: accept relative dates ('demain', "
                "    'vendredi prochain', 'غدا') as-is. Don't insist on "
                "    YYYY-MM-DD."
            )
            # Seller-defined extraction schema (migration 0012). This is the
            # heart of the universal "Any Service" module: the bot must
            # collect EXACTLY these fields, in this order, before confirming.
            if custom_fields:
                product_lines.append(_custom_fields_prompt_block(custom_fields))
        sections.append("\n".join(product_lines))

    # The stage decides exactly what the bot does this turn. The pending
    # summary tells the LLM what's already collected so it doesn't re-ask.
    stage_label, next_action = determine_next_stage(
        pending, history_len, order_placed, kind=kind,
        custom_fields=custom_fields,
    )
    collected = _pending_summary(pending, phone_from_jid, kind=kind,
                                 custom_fields=custom_fields)
    # Build an explicit "still missing" list for THIS turn. The LLM was
    # ignoring missing-vs-set status in the COLLECTED block when it
    # contained both filled and unfilled lines side-by-side — it would
    # pick a random missing field to ask about even when the stage
    # machine pointed elsewhere. We surface ONLY the missing fields in a
    # separate, very loud paragraph so the model can't miss what's left.
    if kind == "service" and custom_fields:
        # Only REQUIRED custom fields gate the flow — matches the dynamic
        # stage machine, which never blocks on an optional "nice to have".
        required_keys = tuple((f["key"], f["label"]) for f in custom_fields
                              if f.get("required", True))
    elif kind == "service":
        required_keys = (("name", "Name"),
                         ("service_date", "Service date"),
                         ("city", "City"),
                         ("address", "Address"),
                         ("notes", "Notes"))
    else:
        required_keys = (("name", "Name"),
                         ("city", "City"),
                         ("address", "Address"),
                         ("quantity", "Quantity"))
    still_missing = [label for key, label in required_keys
                     if not (pending or {}).get(key)]
    missing_block = (
        f"FIELDS STILL TO COLLECT (in order): {' → '.join(still_missing)}"
        if still_missing
        else "ALL FIELDS COLLECTED — proceed to confirmation."
    )
    # Per-turn DYNAMIC state (collected fields + stage + next action). Built
    # here (where its inputs are in scope) but appended LAST — see below — so
    # the big static persona/rules/product bulk above stays a byte-identical
    # prefix across every turn. That lets the model PROMPT-CACHE the prefix,
    # cutting Agent 2 input cost ~50-80% per message with zero change to what
    # the bot actually says.
    dynamic_state_block = (
        f"╔═══ CONTEXT MEMORY (read the full chat history below) ═══╗\n"
        f"You have access to the FULL chat history of this conversation in "
        f"the messages below (every prior user + assistant turn). READ THEM "
        f"BEFORE REPLYING. The customer expects you to remember:\n"
        f"  • Questions they already asked → don't make them repeat\n"
        f"  • Facts they already shared → don't ask again (also see COLLECTED)\n"
        f"  • The thread of the conversation → reply IN CONTEXT, not as if "
        f"    you just walked in\n\n"
        f"COLLECTED SO FAR (extracted from chat history — authoritative):\n"
        f"{collected}\n\n"
        f"⚠️  {missing_block}\n"
        f"⚠️  NEVER ask about a field that is already in COLLECTED. If a "
        f"field is set above, treat it as final unless the customer "
        f"EXPLICITLY corrects it.\n\n"
        f"CURRENT STAGE: {stage_label}\n"
        f"NEXT ACTION (the *default* action when the customer is just "
        f"answering your last question):\n"
        f"  {next_action}\n\n"
        f"╔═══ INTERRUPT RULE (CRITICAL — read carefully) ═══╗\n"
        f"The NEXT ACTION above is the DEFAULT path. But if the customer's "
        f"LAST MESSAGE is itself a QUESTION or a CONCERN (not an answer to "
        f"your previous question), you MUST:\n"
        f"  1. ANSWER their question first, briefly and concretely (1-2 "
        f"     short sentences, accurate to the product info above).\n"
        f"  2. THEN, in the SAME reply, gently bring the flow back by "
        f"     asking the NEXT ACTION question.\n"
        f"Examples of customer messages that REQUIRE an answer first:\n"
        f"  • \"chno katdir had l-produit?\" / \"à quoi ça sert?\" / "
        f"    \"what does it do?\" → explain the benefit in one line, "
        f"    THEN ask the next stage question.\n"
        f"  • \"shhal lprix?\" / \"c'est combien?\" → reveal the price "
        f"    EVEN if we're not at Stage 4 yet (customer-driven price "
        f"    reveals are always allowed), THEN ask quantity.\n"
        f"  • \"wach 100% naturel?\" / \"y a-t-il des effets secondaires?\" "
        f"    → answer briefly + reassure, THEN return to NEXT ACTION.\n"
        f"  • \"shhal kayakhud bach iji?\" / \"délai livraison?\" → answer "
        f"    (24-48h typical), THEN return to NEXT ACTION.\n"
        f"NEVER ignore a customer question to march straight to the next "
        f"stage — that is the #1 thing that makes the bot feel like a robot "
        f"and lose the sale."
    )

    # The TON HUMAIN block. Examples are language-specific so the LLM
    # has actual phrases to mirror instead of translating English in its
    # head. Darija gets its own block because the writing style is very
    # different from MSA Arabic (Latin script + Arabizi numerals).
    if language == "ary":
        sections.append(
            "TON HUMAIN — you are texting on WhatsApp like a real Moroccan "
            "shop owner ka-yhdar m3a customer fl-zen9a. NOT a call-center, "
            "NOT a TV announcer, NOT MSA Arabic. Real WhatsApp Darija = "
            "SHORT + WARM + CASUAL. Write in ARABIC SCRIPT (الكتابة "
            "العربية), pure Moroccan Darija dialect (la3ammiya l-maghribiya). "
            "Ground rule: ila phrase tatha l3lik ila katqraha b voix douce "
            "f WhatsApp, hadi mzyana. Ila kayban scripted/formal → wrong.\n\n"
            "WRITE LIKE THIS (good — real Darija a real Moroccan would type):\n"
            "  GREETINGS / OPENERS:\n"
            "    • \"سلام 😊\"\n"
            "    • \"أهلا خويا\" / \"أهلا ختي\"\n"
            "    • \"لاباس عليك؟\" / \"كي داير؟\"\n"
            "    • \"مرحبا بيك\"\n"
            "  ASKING NAME:\n"
            "    • \"شنو سميتك؟\"\n"
            "    • \"سميتك عافاك؟\"\n"
            "    • \"كيفاش نسميك؟\"\n"
            "  ASKING LOCATION:\n"
            "    • \"فين ساكن؟\"\n"
            "    • \"من أي مدينة؟\"\n"
            "    • \"العنوان ديالك فين؟\"\n"
            "  ASKING QUANTITY / PRICE REVEAL:\n"
            "    • \"شحال بغيتي؟\"\n"
            "    • \"بشحال بغيتي تاخد؟\"\n"
            "    • \"الواحدة بـ ٢٩٩ ألف، بشحال بغيتي؟\"\n"
            "  ACKNOWLEDGMENTS:\n"
            "    • \"واخا 👌\"\n"
            "    • \"صافي\"\n"
            "    • \"ماشي مشكل\"\n"
            "    • \"تمام\"\n"
            "  CLOSING / CONFIRM:\n"
            "    • \"نأكد الطلب؟\"\n"
            "    • \"واخا نسجلها ليك؟\"\n"
            "    • \"المجموع X، التوصيل فابور، الدفع عند الاستلام. واخا؟\"\n\n"
            "NEVER WRITE LIKE THIS (BANNED — these make the bot sound fake):\n"
            "  • \"أهلان نزين هادشي\" ← stiff/scripted, mahdarach a Moroccan. "
            "Use \"أهلا خويا\" or \"مرحبا\".\n"
            "  • \"نزين الأمر\" / \"سنقوم بتسوية\" ← MSA-flavored, BAN.\n"
            "  • \"السلام عليكم، كيف يمكنني مساعدتكم؟\" ← MSA call-center, BAN.\n"
            "  • \"ما اسمك الكامل؟\" ← formal MSA. Use \"شنو سميتك؟\" or \"سميتك عافاك؟\".\n"
            "  • \"يسرني\" / \"يشرفني\" / \"تفضل أخي الكريم\" ← MSA, BAN.\n"
            "  • \"شكراً لتواصلكم معنا\" / \"شكرا لثقتكم\" ← canned, BAN.\n"
            "  • Latin Arabizi (\"salam khoya, labass?\") ← customer typed "
            "Arabic, reply in Arabic script.\n"
            "  • Pure French (\"Bonjour, comment puis-je vous aider ?\") ← BAN.\n"
            "  • Long product explanations — keep replies under 200 chars.\n\n"
            "DARIJA VOCABULARY KIT (use these real words, not MSA equivalents):\n"
            "  bghit/bghiti (بغيت/بغيتي) — want\n"
            "  khoya/khouya (خويا) — bro (friendly form of address)\n"
            "  ch7al/shhal (شحال) — how much/many\n"
            "  wakha (واخا) — ok\n"
            "  safi (صافي) — that's it / done\n"
            "  fin (فين) — where\n"
            "  kifash (كيفاش) — how\n"
            "  dyalek/dyalk (ديالك) — your\n"
            "  daba (دابا) — now\n"
            "  ghadi (غادي) — going to\n"
            "  3andek (عندك) — you have\n"
            "  kayn (كاين) — there is\n\n"
        )
    else:
        sections.append(
            "TON HUMAIN — you are texting on WhatsApp like a real person, not "
            "a call-center agent. Replies must feel warm, casual, and SHORT.\n\n"
            "WRITE LIKE THIS (good):\n"
            "  • \"Bonjour 😊\"\n"
            "  • \"Salut, ça va ?\"\n"
            "  • \"Cool ! Vous vous appelez comment ?\"\n"
            "  • \"Ah ok, et vous êtes où ?\"\n"
            "  • \"Super, je note ça\"\n"
            "  • \"D'accord, combien vous voulez ?\"\n"
            "  • \"299 000 GNF la bouteille. Vous en voulez combien ?\"\n"
            "  • \"Parfait ! Adresse exacte svp ?\"\n"
            "  • \"C'est noté 👌 Je valide la commande ?\"\n\n"
            "NEVER WRITE LIKE THIS (bot/formal — banned):\n"
            "  • \"Quel est votre nom complet ?\"  ← stiff, use \"Vous vous appelez comment ?\"\n"
            "  • \"Comment puis-je vous aider ?\"  ← call-center phrase, banned\n"
            "  • \"Pourriez-vous me communiquer...\" ← way too formal\n"
            "  • \"BioRein est un complément alimentaire naturel...\" ← stop "
            "explaining the product, the customer knows\n"
            "  • \"Je vous remercie d'avoir...\"   ← stiff\n"
            "  • \"N'hésitez pas à me contacter\"  ← canned customer-service\n\n"
        )
    # Two-mode personality — the bot is warm and lightly playful while
    # chatting, then pivots to precise and professional the moment we're
    # confirming the order details. Sellers consistently say this is
    # what their best human reps actually do on WhatsApp.
    sections.append(
        "PERSONALITY — you are a real shop owner, not a chatbot. Two modes:\n\n"
        "  CHAT MODE (Stages 1-3, while gathering interest + name + city):\n"
        "    • Warm, light, a little playful. Use light humor when it "
        "fits — a friendly observation, a gentle joke. Never insult or "
        "be sarcastic. Match the customer's energy.\n"
        "    • Reactions: small empathy bursts. \"Ah cool!\" / \"Super merci!\" "
        "/ \"واخا فهمتك\" / \"ah ça je comprends\".\n"
        "    • If the customer cracks a joke, smile back briefly. If "
        "they sound hesitant, reassure them in ONE short line.\n\n"
        "  CONFIRMATION MODE (Stages 4-5, price reveal + summary + close):\n"
        "    • Precise, professional, zero filler. List the facts: "
        "quantity, total, address. Use a clean bullet style if helpful.\n"
        "    • No jokes here. The customer is about to pay — they want "
        "to feel they're dealing with a serious shop.\n"
        "    • Ask explicitly: \"Je confirme votre commande ?\" / "
        "\"نأكد الطلب؟\" — one direct yes/no question.\n\n"
        f"STYLE RULES:\n"
        f"  • Max 1-2 short sentences in CHAT mode, max 3 short lines "
        f"in CONFIRMATION mode. Hard cap 220 chars.\n"
        f"  • Vary openers every turn: Ah / Cool / Super / Parfait / "
        f"D'accord / Très bien / Bien noté. Don't start three replies "
        f"in a row the same way.\n"
        f"  • At most ONE emoji per message in chat mode, ZERO in "
        f"confirmation mode.\n"
        f"  • Avoid the product name after Stage 2 — say \"ça\", \"votre "
        f"commande\", \"pour vous\". Mirror back what the customer said.\n"
        f"  • Skip salutations after the first turn — the chat is "
        f"already open.\n"
        f"  • Use natural connectors: \"et\", \"du coup\", \"alors\".\n\n"
        f"GOLDEN RULES (hard, never break):\n"
        f"  • ONE question per message. Never bundle multiple asks.\n"
        f"  • Never repeat a question whose answer is already in COLLECTED "
        f"SO FAR — move to the next stage instead.\n"
        f"  • Treat plain numeric replies (\"1\", \"2\", \"3\"…) as quantity "
        f"answers when you've just asked about quantity. Don't ask again.\n"
        f"  • Never reveal the price before STAGE 4.\n"
        f"  • Never ask for the phone number — you already have it from "
        f"WhatsApp.\n"
        f"  • Stay in {lang_label} for every word.\n"
        f"  • QUANTITY SANITY: maximum {MAX_ORDER_QUANTITY} units per order. "
        f"If the customer asks for more (e.g. 100, 1000, 100 000 000), "
        f"politely refuse: explain we don't have that much stock and ask "
        f"how many they REALLY want. Do NOT record an absurd quantity. "
        f"Set extracted_order_fields.quantity to null in that case.\n"
        f"  • INSULTS / ABUSE: if the customer's message is just an insult "
        f"or curse word, do NOT treat it as their name or address. Reply "
        f"calmly that you didn't catch their answer and ask again gently. "
        f"Leave extracted_order_fields.name unset. Stay professional."
    )

    # Dynamic per-turn state goes here — AFTER all the static guidance — so
    # the static bulk above is a stable, cacheable prefix. Placed right before
    # the FINAL REMINDER so the language lock still gets the literal last word,
    # and so "what's collected + next action" is the most recent context the
    # model sees before the chat history.
    sections.append(dynamic_state_block)

    # Final per-turn reminder. Last instruction wins for many LLMs, so we
    # repeat the language lock here.
    sections.append(
        f"FINAL REMINDER (read this last): your reply for this turn MUST be "
        f"written in {lang_label}. If you catch yourself starting in another "
        f"language, restart the sentence in {lang_label}."
    )

    # Agent 1 may have signalled this is the closing turn — inject the
    # vibe-tailored CLOSING MODE block last so it takes precedence over
    # the standard stage instructions above. The block already carries
    # its own "NEVER write generic thank-yous" rule.
    if agent1_closing_block:
        sections.append(agent1_closing_block)

    # Photo intent (the bot just sent — or couldn't find — product pictures
    # the customer asked for). Last so it takes precedence this turn.
    if photo_note:
        sections.append(photo_note)

    return "\n\n".join(sections)


def _extract_json_from_text(raw: str) -> Optional[Dict]:
    """Robust fallback parser for models that wrap JSON in markdown fences,
    add a preamble, or stream a partial trailing comma. We try strict
    json.loads first, then peel off any ```json ... ``` fence, then take
    the FIRST {...} balanced block.

    Returns the parsed dict, or None when nothing valid is found.
    """
    if not raw:
        return None
    # Strict pass.
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    # Strip markdown fences (Gemini and Claude occasionally wrap JSON in
    # ```json ... ``` even when response_format=json_object).
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.S)
    if fenced:
        try:
            return json.loads(fenced.group(1))
        except json.JSONDecodeError:
            pass
    # Take the first balanced {...} block by counting braces. Works for
    # objects that contain nested objects (extracted_order_fields).
    start = raw.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(raw)):
        ch = raw[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(raw[start:i + 1])
                except json.JSONDecodeError:
                    return None
    return None


def _supports_response_format(model: str) -> bool:
    """OpenRouter's adapters for some providers (notably older Gemini
    preview models) reject `response_format=json_object` with a 4xx —
    they only accept plain text + a "please return JSON" prompt. We
    keep a small denylist here and pass through everything else.

    GPT-4o / Claude / Llama all support response_format reliably.
    """
    m = (model or "").lower()
    # Empirically, gemini-3.x-pro-preview reliably supports json_object
    # via OpenRouter (verified 2026-05). Image / multimodal variants
    # don't accept it for tool-call-style returns.
    if "image" in m or "tts" in m or "embedding" in m:
        return False
    return True


# ════════════════════════════════════════════════════════════════════════
# AI USAGE / BILLING — token-by-token accounting (migration 0009)
# ════════════════════════════════════════════════════════════════════════
#
# Every LLM call captures usage.{prompt,completion,total}_tokens from the
# OpenRouter response, inserts an ai_usage_log row, and decrements
# organizations.ai_tokens_balance. The dashboard top-bar reads the
# balance via GET /funnel/billing/usage.
#
# We use a thread-local for the per-request context (seller_id +
# organization_id + conversation_id + agent label) so the signatures of
# llm_reply / llm_raw_call don't have to change for every call site.
# Flask runs each request in its own thread (threaded=True is the
# default for `app.run`), so thread-local is the right scope.

import threading as _bill_threading

_usage_ctx = _bill_threading.local()


def set_usage_context(*, seller_id: Optional[str] = None,
                      organization_id: Optional[str] = None,
                      conversation_id: Optional[str] = None,
                      agent: str = "agent2") -> None:
    """Stamp the current thread with billing context. process_inbound_message
    calls this once after resolving the seller; agents.run_agent1 flips
    the `agent` field to 'agent1' for the duration of its Agent 1 calls
    and flips back afterwards. Idempotent — safe to call multiple times."""
    _usage_ctx.seller_id = seller_id
    _usage_ctx.organization_id = organization_id
    _usage_ctx.conversation_id = conversation_id
    _usage_ctx.agent = agent


def clear_usage_context() -> None:
    for attr in ("seller_id", "organization_id", "conversation_id", "agent"):
        if hasattr(_usage_ctx, attr):
            delattr(_usage_ctx, attr)


def _log_ai_usage(model: str, completion: Any,
                  agent_override: Optional[str] = None) -> None:
    """Record one ai_usage_log row + decrement the org's token balance.
    Best-effort: any failure (missing migration, network blip) is logged
    at debug level and swallowed — never fails the inbound message path.

    `agent_override` lets the caller pin the agent label even when the
    thread context says something different (used by agents.run_agent1
    so its calls land as 'agent1' regardless of the surrounding ctx).
    """
    usage = getattr(completion, "usage", None)
    if not usage:
        return
    pt = int(getattr(usage, "prompt_tokens", 0) or 0)
    ct = int(getattr(usage, "completion_tokens", 0) or 0)
    tt = int(getattr(usage, "total_tokens", 0) or (pt + ct))
    if tt <= 0:
        return

    org_id = getattr(_usage_ctx, "organization_id", None)
    seller_id = getattr(_usage_ctx, "seller_id", None)
    conv_id = getattr(_usage_ctx, "conversation_id", None)
    agent = agent_override or getattr(_usage_ctx, "agent", "agent2")

    if not org_id:
        # No billing context set — this is an admin endpoint test or a
        # standalone script. Skip accounting.
        return

    try:
        _supa_post("ai_usage_log", {
            "organization_id": org_id,
            "seller_id": seller_id,
            "conversation_id": conv_id,
            "agent": agent,
            "model": model,
            "prompt_tokens": pt,
            "completion_tokens": ct,
            "total_tokens": tt,
        })
    except Exception as exc:
        log.debug("[billing] ai_usage_log insert failed: %s", exc)

    # Decrement balance. PostgREST doesn't expose atomic increments, so
    # we read-modify-write — a tiny race window is acceptable since the
    # worst case is a few tokens of slack per concurrent message.
    try:
        rows = _supa_get("organizations", {
            "id": f"eq.{org_id}",
            "select": "ai_tokens_balance",
        })
        if rows:
            cur = int(rows[0].get("ai_tokens_balance") or 0)
            new = max(0, cur - tt)
            _supa_patch("organizations", {"id": org_id},
                        {"ai_tokens_balance": new})
    except Exception as exc:
        log.debug("[billing] balance decrement failed: %s", exc)


def _resolve_organization_id_for_seller(seller_id: str) -> Optional[str]:
    """Look up the org for a seller. Returns None if migration 0009
    isn't applied yet OR the seller predates the backfill."""
    if not seller_id:
        return None
    try:
        rows = _supa_get("sellers", {
            "id": f"eq.{seller_id}",
            "select": "organization_id",
            "limit": "1",
        })
        if rows:
            return rows[0].get("organization_id")
    except Exception:
        # Column not migrated yet — silent fallback.
        pass
    return None


def _trial_allows_reply(seller: Dict, organization_id: Optional[str]) -> bool:
    """Whether the bot may reply for this seller right now.

    Trial accounts (sellers.is_trial = true) may use the bot until their
    trial window closes — whichever comes first:
      • TRIAL_DAYS elapsed since signup (trial_ends_at), OR
      • TRIAL_CONVERSATIONS_CAP distinct customer conversations started.
    An active paid subscription overrides the trial entirely.

    Fails OPEN (returns True) on any error or when the trial columns
    aren't migrated yet, so a live/paid seller is never accidentally
    muted by this gate.
    """
    try:
        # Not a trial account (paid plan, legacy seller, or migration not
        # applied → is_trial is None/false) → unaffected.
        if not seller.get("is_trial"):
            return True

        # Converted to a paid plan? An active subscription wins.
        if organization_id:
            try:
                subs = _supa_get("subscriptions", {
                    "organization_id": f"eq.{organization_id}",
                    "status": "eq.active",
                    "select": "id",
                    "limit": "1",
                })
                if subs:
                    return True
            except Exception:
                pass

        from datetime import datetime as _dt, timezone as _tz

        # 1. Time limit.
        ends = seller.get("trial_ends_at")
        if ends:
            try:
                ends_dt = _dt.fromisoformat(str(ends).replace("Z", "+00:00"))
                if _dt.now(_tz.utc) > ends_dt:
                    return False
            except Exception:
                pass

        # 2. Conversation-count limit. Count distinct customer
        # conversations started during the trial; a cap+1 limit keeps the
        # query cheap regardless of catalogue size.
        cap = int(seller.get("trial_conversations_cap") or TRIAL_CONVERSATIONS_CAP)
        params = {
            "seller_id": f"eq.{seller.get('id')}",
            "select": "id",
            "limit": str(cap + 1),
        }
        started = seller.get("trial_started_at")
        if started:
            params["created_at"] = f"gte.{started}"
        try:
            rows = _supa_get("customer_conversations", params) or []
            if len(rows) >= cap:
                return False
        except Exception:
            pass

        return True
    except Exception:
        return True


def _trial_status_for_seller(seller_id: str) -> Dict[str, Any]:
    """Trial snapshot for the dashboard Billing page.

    Returns is_trial / trial_ends_at / trial_days_left /
    trial_conversations_used / trial_conversations_cap. Defaults (not on
    trial) when the columns aren't migrated or the seller has converted.
    Never raises."""
    out: Dict[str, Any] = {
        "is_trial": False,
        "trial_ends_at": None,
        "trial_days_left": 0,
        "trial_conversations_used": 0,
        "trial_conversations_cap": TRIAL_CONVERSATIONS_CAP,
    }
    if not seller_id:
        return out

    import math
    from datetime import datetime as _dt, timezone as _tz, timedelta as _td

    # Preferred path: the migrated trial columns (migration 0013_seller_free_trial).
    # If they aren't present yet, PostgREST 400s the whole select and _supa_get
    # returns [] — we then fall back to deriving the trial from sellers.created_at
    # below, so the trial still works on a database that hasn't had 0013 applied.
    rows = []
    try:
        rows = _supa_get("sellers", {
            "id": f"eq.{seller_id}",
            "select": "is_trial,trial_started_at,trial_ends_at,trial_conversations_cap",
            "limit": "1",
        }) or []
    except Exception:
        rows = []

    trial_started = None

    if rows:
        # Trial columns exist. Honour the explicit flag — false means a paid /
        # converted / legacy seller, so no trial.
        s = rows[0]
        if not s.get("is_trial"):
            return out
        out["is_trial"] = True
        out["trial_ends_at"] = s.get("trial_ends_at")
        out["trial_conversations_cap"] = int(s.get("trial_conversations_cap") or TRIAL_CONVERSATIONS_CAP)
        trial_started = s.get("trial_started_at")
    else:
        # Columns not migrated (or seller missing) → derive from created_at:
        # a seller is on the free trial for TRIAL_DAYS after signup. After that
        # window we fall through to the default ("not on trial").
        try:
            crows = _supa_get("sellers", {
                "id": f"eq.{seller_id}",
                "select": "created_at",
                "limit": "1",
            }) or []
        except Exception:
            crows = []
        created = crows[0].get("created_at") if crows else None
        if not created:
            return out
        try:
            created_dt = _dt.fromisoformat(str(created).replace("Z", "+00:00"))
        except Exception:
            return out
        ends_dt = created_dt + _td(days=TRIAL_DAYS)
        if ends_dt <= _dt.now(_tz.utc):
            return out  # trial window already elapsed
        out["is_trial"] = True
        out["trial_ends_at"] = ends_dt.isoformat()
        out["trial_conversations_cap"] = TRIAL_CONVERSATIONS_CAP
        trial_started = created

    # Days remaining until the trial closes.
    ends = out["trial_ends_at"]
    if ends:
        try:
            ends_dt = _dt.fromisoformat(str(ends).replace("Z", "+00:00"))
            secs = (ends_dt - _dt.now(_tz.utc)).total_seconds()
            out["trial_days_left"] = max(0, math.ceil(secs / 86400)) if secs > 0 else 0
        except Exception:
            out["trial_days_left"] = 0

    # Distinct conversations consumed since the trial began.
    cap = int(out["trial_conversations_cap"] or TRIAL_CONVERSATIONS_CAP)
    params = {
        "seller_id": f"eq.{seller_id}",
        "select": "id",
        "limit": str(cap + 5),
    }
    if trial_started:
        params["created_at"] = f"gte.{trial_started}"
    try:
        out["trial_conversations_used"] = len(_supa_get("customer_conversations", params) or [])
    except Exception:
        out["trial_conversations_used"] = 0

    return out


def _ensure_organization_for_seller(seller_id: str) -> Optional[str]:
    """Resolve — or lazily CREATE — the organization for a seller.

    Signup creates the seller + trial but not an organization, and the
    0009 backfill only covers sellers that existed when it ran. This makes
    the billing/subscription layer work for everyone: returns the existing
    organization_id, or creates one (named after the seller's business),
    owned by the seller's app_user, links it back, and returns the new id.

    Returns None when the organizations table isn't there yet (pre-0009)
    or on any error — every caller already tolerates a None org."""
    if not seller_id:
        return None
    existing = _resolve_organization_id_for_seller(seller_id)
    if existing:
        return existing
    try:
        srows = _supa_get("sellers", {
            "id": f"eq.{seller_id}", "select": "id,business_name", "limit": "1",
        }) or []
        if not srows:
            return None
        name = (srows[0].get("business_name") or "My business").strip() or "My business"
        # owner_user_id is NOT NULL + FK to auth.users → must be the seller's app_user.
        owner = None
        try:
            arows = _supa_get("app_users", {
                "seller_id": f"eq.{seller_id}", "role": "eq.seller",
                "select": "id", "order": "created_at.asc", "limit": "1",
            }) or []
            if arows:
                owner = arows[0].get("id")
        except Exception:
            owner = None
        if not owner:
            return None  # can't satisfy NOT NULL owner (pre-migration / orphan)
        created = _supa_post("organizations", {"name": name, "owner_user_id": owner})
        if not created or not created.get("id"):
            return None
        org_id = created["id"]
        try:
            _supa_patch("sellers", {"id": seller_id}, {"organization_id": org_id})
        except Exception:
            pass
        log.info("[org] lazily created organization %s for seller %s", org_id, seller_id)
        return org_id
    except Exception as exc:
        log.warning("[org] ensure-organization failed for seller %s: %s", seller_id, exc)
        return None


def _seller_has_active_paid_plan(org_id: Optional[str]) -> Optional[str]:
    """Tier of an org's ACTIVE paid subscription, or None. None also when
    the subscriptions table doesn't exist yet (pre-0010)."""
    if not org_id:
        return None
    try:
        subs = _supa_get("subscriptions", {
            "organization_id": f"eq.{org_id}", "status": "eq.active",
            "select": "tier", "limit": "1",
        }) or []
        if subs:
            return subs[0].get("tier") or "active"
    except Exception:
        pass
    return None


_BILLING_SCHEMA_READY: Optional[bool] = None


def _billing_schema_ready() -> bool:
    """Whether the billing tables (migrations 0009/0010 — subscriptions etc.)
    exist on the DB. Cached after the first positive result.

    Until they exist the access gate stays OPEN: hard-blocking a trial-expired
    seller without the subscribe → admin-activate tables would strand them with
    no way back. So the block SELF-ACTIVATES the moment the SQL is applied — no
    brain restart needed once this code is running."""
    global _BILLING_SCHEMA_READY
    if _BILLING_SCHEMA_READY:
        return True
    if not (SUPABASE_URL and SUPABASE_SERVICE_KEY):
        return False
    try:
        r = httpx.get(
            f"{SUPABASE_URL}/rest/v1/subscriptions",
            params={"select": "id", "limit": "1"},
            headers=_supa_headers(),
            timeout=8,
            verify=_SUPA_VERIFY,
        )
        if r.status_code in (200, 206):
            _BILLING_SCHEMA_READY = True
            return True
    except Exception:
        pass
    return False


def _seller_access_state(seller_id: str) -> Dict[str, Any]:
    """Whether a seller may MANAGE their account right now — connect a
    WhatsApp session or create a product/service.

      allowed=True  → ACTIVE free trial, OR active paid plan, OR a
                      non-trial/legacy seller (is_trial=false) we must not
                      block.
      allowed=False → the free trial has DEFINITIVELY ended (time window
                      OR conversation cap) AND there's no active paid plan.

    The block is scoped to is_trial=true accounts ONLY — a converted /
    legacy / admin-activated seller (is_trial=false) is always allowed, so
    this gate can never lock out a non-trial account. Fails OPEN on any
    error. Honours TRIAL_HARD_BLOCK (off → reports state but never refuses)."""
    state = {
        "allowed": True, "reason": "ok", "is_trial": False,
        "trial_days_left": 0, "plan": None, "pending": False,
    }
    if not seller_id:
        return state
    try:
        schema_ready = _billing_schema_ready()
        org_id = _resolve_organization_id_for_seller(seller_id)

        # 1. Active PAID plan wins outright.
        plan = _seller_has_active_paid_plan(org_id)
        if plan:
            state.update(allowed=True, reason="paid_active", plan=plan)
            return state

        # 2. Pending request? (drives the "awaiting activation" copy.)
        if org_id:
            try:
                pend = _supa_get("subscriptions", {
                    "organization_id": f"eq.{org_id}",
                    "status": "eq.pending_admin_review",
                    "select": "id", "limit": "1",
                }) or []
                state["pending"] = bool(pend)
            except Exception:
                pass

        # 3. No paid plan → evaluate the trial. ONLY is_trial=true accounts
        #    can be blocked; everyone else stays allowed.
        ts = _trial_status_for_seller(seller_id)
        if ts.get("is_trial"):
            days_left = int(ts.get("trial_days_left") or 0)
            used = int(ts.get("trial_conversations_used") or 0)
            cap = int(ts.get("trial_conversations_cap") or TRIAL_CONVERSATIONS_CAP)
            state.update(is_trial=True, trial_days_left=days_left)
            if days_left <= 0 or used >= cap:
                state.update(allowed=False, reason="trial_expired")
            else:
                state.update(allowed=True, reason="trial_active")
        else:
            state["reason"] = "not_trial"  # allowed stays True

        # Only ENFORCE the block when the hard-block is on AND the billing
        # tables exist (so the seller has a real path back via subscribe →
        # admin activate). Otherwise report the state but keep access OPEN.
        if state["reason"] == "trial_expired" and not (TRIAL_HARD_BLOCK and schema_ready):
            state["allowed"] = True
        return state
    except Exception:
        return {"allowed": True, "reason": "error_fail_open", "is_trial": False,
                "trial_days_left": 0, "plan": None, "pending": False}


def _trial_blocked_response(state: Dict[str, Any], action: str):
    """402 payload for a trial-expired account attempting a mutation. The
    dashboard keys off error=='trial_expired' to show the upgrade prompt."""
    pending = bool(state.get("pending"))
    if pending:
        msg = ("Votre demande d'abonnement est en attente de validation. "
               "L'accès sera débloqué dès que l'administrateur active le paiement.")
    else:
        msg = ("Votre essai gratuit est terminé. Choisissez un plan pour "
               "continuer — l'accès est débloqué après l'activation du "
               "paiement par l'administrateur.")
    return _cors(jsonify({
        "error": "trial_expired",
        "reason": state.get("reason"),
        "pending": pending,
        "action": action,
        "message": msg,
    })), 402


def llm_raw_call(messages: List[Dict], model: str,
                 use_response_format: bool = True,
                 max_tokens: int = 700) -> Tuple[str, str]:
    """Raw single-shot LLM call returning (raw_text, finish_reason). No
    JSON parsing, no retries — the caller (e.g. Agent 1) implements its
    own triple-tier fallback. This is the low-level hook agents.py uses
    so it can decide whether to retry with/without response_format
    based on finish_reason.

    Reuses the OpenAI client + the live OpenRouter key. response_format
    is only attached when use_response_format=True AND the model is
    known to support it.
    """
    live_key = get_openrouter_key()
    if live_key and getattr(client, "api_key", "") != live_key:
        client.api_key = live_key
    kwargs: Dict[str, Any] = dict(
        model=model,
        messages=messages,
        max_tokens=max_tokens,
        temperature=0.3,           # analytical default — Agent 1 wants determinism
        presence_penalty=0.0,
        frequency_penalty=0.0,
    )
    if use_response_format and _supports_response_format(model):
        kwargs["response_format"] = {"type": "json_object"}
    try:
        completion = client.chat.completions.create(**kwargs)
        # Account for tokens — llm_raw_call is the Agent 1 path, so
        # label the usage row accordingly. If the calling context
        # already set a different agent (e.g. an admin tool calling
        # llm_raw_call directly), that wins via override semantics.
        _log_ai_usage(model, completion, agent_override="agent1")
        choice = completion.choices[0]
        finish = getattr(choice, "finish_reason", "unknown") or "unknown"
        raw = (choice.message.content or "").strip()
        return raw, finish
    except Exception as exc:
        msg = str(exc).lower()
        # Some providers reject response_format with a 400. Caller will
        # see this in the empty-text + log and retry tier 2.
        if "response_format" in msg or "json_object" in msg or "400" in msg[:50]:
            log.info("[llm-raw] %s rejected response_format: %s", model,
                     str(exc)[:160])
            return "", "rejected"
        log.warning("[llm-raw] %s call failed: %s", model, str(exc)[:200])
        return "", "exception"


def llm_reply(messages: List[Dict], model: str) -> Dict:
    """Call OpenRouter. Returns a dict with at least {reply, intent,
    extracted_order_fields?}. Falls back to a plain reply on JSON failure.

    Defensive multi-tier strategy:
      1. Try with response_format=json_object (best — model is forced to
         emit valid JSON).
      2. If the provider rejects response_format (4xx with that error),
         retry the same call WITHOUT response_format and parse the JSON
         out of the text body — this is what handles older Gemini preview
         endpoints + a few specialty models.
      3. If parsing still fails, return reply=raw-text so the customer
         at least gets *something* instead of an empty fallback.
    """
    # Live-reload OpenRouter key on each call — admin can rotate it
    # via /funnel/admin/settings without restarting the brain.
    live_key = get_openrouter_key()
    if live_key and getattr(client, "api_key", "") != live_key:
        client.api_key = live_key

    common_kwargs = dict(
        model=model,
        messages=messages,
        # Bumped 300 → 700: the JSON schema (reply + intent + 4 extracted
        # fields) adds ~60 tokens of structural overhead before the reply
        # text starts. At 300 the model was running out of room mid-JSON
        # and OpenRouter was returning empty content (we measured a 54%
        # empty-reply rate). 700 gives the model space for a 2-3 sentence
        # confirmation summary plus all the structured fields.
        max_tokens=700,
        # Lowered from 0.85 → 0.4 to make the bot strictly follow the
        # system prompt's staged-flow instructions instead of "creatively"
        # inventing new sales angles.
        temperature=0.4,
        # Reduced penalties (was 0.2 / 0.3): combined with low temperature
        # and the very structured JSON output, the high penalties were
        # making the model produce shorter-than-intended replies (or
        # truncated JSON) because every repeat of "client / product /
        # commande" was being penalised. 0.05 still discourages verbatim
        # repetition without starving the model.
        presence_penalty=0.05,
        frequency_penalty=0.1,
    )

    raw = ""
    default_use_rf = _supports_response_format(model)

    def _call(**extra):
        completion = client.chat.completions.create(**common_kwargs, **extra)
        # Account for tokens — llm_reply is the Agent 2 (Communicator)
        # path. Usage row goes to ai_usage_log + decrements the org's
        # balance. Skipped silently when no usage context is set.
        _log_ai_usage(model, completion, agent_override="agent2")
        return completion

    def _do_one_call(use_rf: bool) -> Tuple[str, Optional[Dict], str]:
        """Single LLM round-trip. Returns (raw_text, parsed_or_None,
        finish_reason). When use_rf is True we ask OpenRouter to enforce
        JSON output via response_format; when False we trust the prompt
        + post-parse via _extract_json_from_text instead. The fallback
        path matters for gpt-5.1-chat which has been observed returning
        empty content + finish_reason=stop under response_format — it
        seems to silently discard outputs that don't match the JSON
        schema rather than retry."""
        if use_rf:
            try:
                completion = _call(response_format={"type": "json_object"})
            except Exception as fmt_exc:
                msg = str(fmt_exc).lower()
                if ("response_format" in msg or "json_object" in msg
                        or "unsupported" in msg or "400" in msg[:50]):
                    log.info("[llm] %s rejected response_format — "
                             "falling back to plain-text + post-parse", model)
                    completion = _call()
                else:
                    raise
        else:
            completion = _call()
        choice = completion.choices[0]
        finish_reason = getattr(choice, "finish_reason", "unknown") or "unknown"
        raw_text = (choice.message.content or "").strip()
        parsed_obj = _extract_json_from_text(raw_text) if raw_text else None
        if not raw_text or parsed_obj is None:
            log.info("[llm] %s returned len=%d finish_reason=%s use_rf=%s raw=%r",
                     model, len(raw_text), finish_reason, use_rf,
                     raw_text[:240])
        return raw_text, parsed_obj, finish_reason

    try:
        raw, parsed, finish = _do_one_call(default_use_rf)
        # First retry: if reply is empty with finish_reason=stop, the
        # model's JSON layer silently discarded the output. Drop
        # response_format on retry and rely on the prompt + robust
        # post-parser — gpt-5.1-chat in particular is significantly
        # more reliable that way.
        empty = parsed is None or not (parsed.get("reply") or "").strip()
        if empty and finish == "stop" and default_use_rf:
            log.info("[llm] %s empty/stop with response_format — "
                     "retrying WITHOUT response_format", model)
            raw, parsed, finish = _do_one_call(False)
            empty = parsed is None or not (parsed.get("reply") or "").strip()
        # Second retry: still empty? give it one more shot with the same
        # config — covers transient OpenRouter blips. Cap at 2 retries
        # total to keep the customer-visible latency reasonable.
        if empty:
            log.info("[llm] %s still empty after first retry — one more attempt", model)
            raw, parsed, _finish = _do_one_call(False)
        if parsed is not None:
            return parsed
        return {"reply": raw, "intent": "asking_info"}
    except Exception as exc:
        log.exception("[llm] call failed: %s", exc)
        return {"reply": "", "intent": "asking_info"}


# ── Order push to seller's / product's Google Sheets ────────────────────
def _resolve_sheets_webhook(seller: Dict, product: Optional[Dict]) -> str:
    """Per-product webhook wins, seller-wide URL is the fallback. Sellers
    who want all confirmed leads in one sheet leave the product field blank
    and set only the seller-level URL; sellers who run multiple campaigns
    point each product to its own sheet."""
    product_url = ((product or {}).get("sheets_webhook_url") or "").strip()
    if product_url:
        return product_url
    return ((seller or {}).get("sheets_webhook_url") or "").strip()


def push_order_to_sheet(seller: Dict, product: Optional[Dict], order: Dict) -> bool:
    """POST a single order row to whichever Apps Script webhook is
    configured (product first, seller fallback). Returns True on success.

    Google Apps Script Web Apps respond with HTTP 302 to redirect to
    `script.googleusercontent.com/...?lib=...`. Every HTTP client —
    including httpx with `follow_redirects=True` — downgrades POST → GET
    on 302 per RFC 7231. That kills the request because the script only
    defines doPost. We therefore disable automatic redirects and re-POST
    the same body to the Location header ourselves (up to two hops, which
    is what Apps Script needs).
    """
    url = _resolve_sheets_webhook(seller, product)
    if not url:
        log.info("[sheets] no webhook URL for seller=%s product=%s — skipping",
                 (seller or {}).get("id"), (product or {}).get("id"))
        return False
    try:
        # Reuse the same TLS-verify flag we use for Supabase. On dev
        # Windows boxes the certifi bundle is missing the local issuer
        # roots, so verification fails the same way against any HTTPS
        # endpoint — including Apps Script.
        #
        # Google Apps Script flow:
        #   POST /macros/s/.../exec   → 302 to script.googleusercontent.com
        #                               (doPost ALREADY RAN at this point —
        #                               your sheet has already been written)
        #   GET  /macros/echo?...     → 200 with the response body
        # The googleusercontent endpoint only accepts GET (POST → 405),
        # so treat the initial 302 as success and (optionally) GET the
        # response body to surface ok=false errors from the script.
        r = httpx.post(url, json=order, timeout=20,
                       follow_redirects=False, verify=_SUPA_VERIFY)
        ok = False
        body_text = ""
        if r.status_code in (200, 201, 204):
            ok = True
            body_text = r.text or ""
        elif r.status_code in (301, 302, 303, 307, 308):
            # Apps Script success path. Try to fetch the body via GET so
            # we can surface script-reported errors (doPost catch block).
            loc = r.headers.get("location") or r.headers.get("Location")
            ok = True  # default: doPost ran, sheet write happened
            if loc:
                try:
                    g = httpx.get(loc, timeout=10, follow_redirects=True,
                                  verify=_SUPA_VERIFY)
                    body_text = g.text or ""
                except Exception as gx:
                    log.debug("[sheets] follow-up GET failed (still treating POST as ok): %s", gx)
        # If body says explicitly ok=false, override the success.
        if ok and body_text:
            try:
                body_json = json.loads(body_text)
                if isinstance(body_json, dict) and body_json.get("ok") is False:
                    ok = False
                    log.warning("[sheets] script returned ok=false: %s", body_json)
            except Exception:
                pass
        if ok:
            log.info("[sheets] ✓ order %s pushed (seller %s, product %s)",
                     order.get("id"), (seller or {}).get("id"), (product or {}).get("id"))
        else:
            log.warning("[sheets] HTTP %s for seller=%s · %s",
                        r.status_code, (seller or {}).get("id"), r.text[:300])
        return ok
    except Exception as exc:
        log.warning("[sheets] push exception: %s", exc)
        return False


# Backwards-compatible name.
def push_order_to_seller_sheet(seller: Dict, order: Dict) -> bool:
    return push_order_to_sheet(seller, None, order)


def push_lead_to_sheet(seller: Dict, product: Optional[Dict],
                       conversation: Dict, from_jid: str,
                       phone: str) -> bool:
    """Push an early-lead row the moment the bot detects which product
    the customer is asking about — long before they confirm an order.

    The point is so the seller can manually follow up on customers who
    ghost mid-conversation. The row only contains what we know at this
    point (Phone), with everything else empty so it visually stands out
    from a confirmed-order row in the sheet (which fills sku/name/qty
    /total). Identical column shape to a normal order row so the
    seller's existing Apps Script (which uses headers.map and appendRow)
    works without modification.
    """
    if not (seller and product and phone):
        return False
    sheet_payload = {
        # Canonical six — leave everything but Phone empty so this row
        # is unmistakably a "lead captured, not yet confirmed" entry.
        "sku":           "",
        "Customer_Name": "",
        "Phone":         phone,
        "address":       "",
        "Quantity":      "",
        "total_price":   "",
        # Extras (richer Apps Scripts can read these via data[key]).
        "id":            conversation.get("id"),
        "product_name":  product.get("name") or "",
        "customer_jid":  from_jid,
        "event":         "lead",
        "status":        "lead",
        "created_at":    datetime.now(timezone.utc).isoformat(),
    }
    return push_order_to_sheet(seller, product, sheet_payload)


# ── Pending-order accumulation across turns ──────────────────────────────
REQUIRED_ORDER_FIELDS = ("name", "address", "city")  # phone comes from JID, quantity defaults to 1


def extract_quantity_from_text(text: str) -> Optional[int]:
    """If the customer's reply is a bare number (with at most a unit word
    like 'pcs' or 'bouteilles'), return it. The LLM sometimes hesitates to
    treat a plain '1' as a quantity answer; this Python-side fallback
    makes it deterministic."""
    if not text:
        return None
    stripped = text.strip().lower()
    # "1", "2", "10"
    m = re.fullmatch(r"(\d{1,4})", stripped)
    if m:
        return int(m.group(1))
    # "1 pcs", "2 bouteilles", "3 unités", "1pc"
    m = re.fullmatch(
        r"(\d{1,4})\s*(pc|pcs|piece|pieces|pièce|pièces|bouteille|bouteilles|unite|unites|unité|unités|unit|units|item|items|قطعة|قطع)\.?",
        stripped,
    )
    if m:
        return int(m.group(1))
    return None


# Common profanity / insult tokens in Darija (Latin & Arabic), Arabic,
# French, and English. Used to prevent the LLM from saving a customer's
# curse-word reply as `customer_name`. Kept short and focused on the
# tokens that actually appear in WhatsApp e-commerce abuse logs — we're
# not trying to be a full content moderator, just to stop garbage
# customer-name rows from landing in the seller's Google Sheet.
_INSULT_TOKENS = (
    # Darija / Arabic (Latin Arabizi + Arabic letters)
    "mok", "moak", "bok", "boak", "kh't", "khouk",
    "zb", "zebbi", "zabour", "zamel",
    "chno sir", "sir 3nd", "sir l", "kha3i",
    "tabon", "tbon", "lkahba", "kahba", "qhab",
    "حشومة", "قحبة", "زامل", "زبي", "كحبة", "أمك",
    # MSA Arabic generic abuse
    "كلب", "حقير", "غبي",
    # French
    "merde", "putain", "salope", "connard", "connasse", "encule", "enculé",
    "fdp", "fils de", "ta mere", "ta mère",
    # English
    "fuck", "shit", "bitch", "asshole", "dick", "cunt",
)


def looks_like_insult(text: str) -> bool:
    """Return True if `text` contains an obvious curse / insult. Used to
    veto setting that text as the customer's name."""
    if not text:
        return False
    norm = text.lower().strip()
    return any(tok in norm for tok in _INSULT_TOKENS)


def looks_like_real_name(text: str) -> bool:
    """True if `text` plausibly is a person's name (or shop business
    name) — 2-30 chars, mostly letters / spaces / common hyphens, and
    NOT an insult. Used to validate the LLM's extracted name before we
    save it on the customer's conversation."""
    if not text or not isinstance(text, str):
        return False
    norm = text.strip()
    if not (2 <= len(norm) <= 30):
        return False
    if looks_like_insult(norm):
        return False
    # At least 2 letter-characters (covers Latin + Arabic + extended).
    letter_count = sum(1 for ch in norm if ch.isalpha())
    if letter_count < 2:
        return False
    return True


def merge_pending_order_fields(conversation_id: str, current: Dict,
                               extracted: Dict) -> Dict:
    """Merge newly-extracted fields into the conversation's running pending
    order. Persists the merged dict back to Supabase (best-effort — if the
    column doesn't exist yet, the in-memory merge is still returned so the
    rest of the turn works).

    Two server-side validations make sure abusive / nonsensical customer
    messages don't pollute the order data the seller eventually sees:
      • `customer_name` is dropped when it's empty, too short/long, or
        contains an obvious insult token (per looks_like_real_name).
      • `quantity` is capped at MAX_ORDER_QUANTITY. The bot can't book
        a 100-million-unit order even if a (joking/abusive) customer
        types one.
    """
    if not isinstance(extracted, dict):
        return current or {}
    merged = dict(current or {})
    for k, v in extracted.items():
        if v is None or v == "":
            continue
        # Don't let the LLM overwrite a phone we extracted from the JID.
        if k == "phone" and merged.get("phone"):
            continue
        # Name sanity: drop obvious insults / random text masquerading as
        # a name. Without this, "3rfti chno sir 3nd mok" used to land in
        # customer_name.
        if k == "name" and not looks_like_real_name(v):
            log.info("[order] dropped suspicious name extraction: %r", v[:40])
            continue
        # Quantity sanity: clamp to MAX_ORDER_QUANTITY so 100 000 000
        # never becomes a real order.
        if k == "quantity":
            try:
                qn = int(v)
            except (TypeError, ValueError):
                continue
            if qn < 1:
                continue
            if qn > MAX_ORDER_QUANTITY:
                log.info("[order] absurd quantity %s clamped/rejected", qn)
                # Don't persist absurd quantities — leave the field unset
                # so the bot can re-ask in its next turn. The system
                # prompt also asks the LLM to refuse the request.
                continue
            merged[k] = qn
            continue
        merged[k] = v
    if merged != (current or {}):
        ok = _supa_patch("customer_conversations", {"id": conversation_id}, {
            "pending_order_fields": merged,
        })
        if not ok:
            log.debug("[order] couldn't persist pending_order_fields — column "
                      "may not exist yet (apply migration 0002).")
    return merged


def order_ready_to_push(pending: Dict, kind: str = "product",
                        custom_fields: Optional[List[Dict]] = None) -> bool:
    """Returns True when we have enough data to push a row to the seller's
    sheet. Field set depends on `kind`:
      • product (e-com): name + address + city. quantity defaults to 1.
      • service (booking) WITH a custom_fields schema (migration 0012): every
        REQUIRED custom field must be filled — the seller defined exactly
        what makes the booking actionable, so we honour that list verbatim.
        (If the seller marked nothing required, fall back to needing a name
        so we never push a totally empty booking.)
      • service (booking) without custom_fields: name + address + city +
        service_date — the date is what makes a booking actionable.
    """
    if kind == "service" and custom_fields:
        required = [f["key"] for f in custom_fields if f.get("required", True)]
        if not required:
            return bool(pending.get("name"))
        return all(pending.get(k) for k in required)
    base = ("name", "address", "city")
    if kind == "service":
        return all(pending.get(k) for k in (*base, "service_date"))
    return all(pending.get(k) for k in base)


# Currency codes / symbols we accept after a price in a description. Used
# only to anchor the regex — we don't actually require a currency match,
# but seeing one boosts confidence the digits were a price and not random.
_CURRENCY_HINT = (
    r"(?:GNF|MAD|EUR|USD|XOF|XAF|CFA|MRU|MRO|TND|DZD|EGP|SAR|AED|GBP|CAD|"
    r"\$|€|£|₣|د\.ج|د\.م\.|درهم|دولار|يورو|أوقية|فرنك)"
)

# Unit words that signal a quantity (e.g. "2 bouteilles", "3 boxes"). The
# bot is mostly used for physical-goods e-commerce, so we cover French +
# English + Arabic e-commerce vocabulary, including misspellings.
_QTY_UNIT = (
    r"(?:bouteille|bouteilles|btl|btls|boite|boîte|boites|boîtes|box|boxes|"
    r"unite|unites|unité|unités|unit|units|"
    r"pcs|pc|piece|pieces|pièce|pièces|item|items|"
    r"pack|packs|coffret|coffrets|carton|cartons|"
    r"sachet|sachets|flacon|flacons|"
    r"قطعة|قطع|عبوة|عبوات|علبة|علب|زجاجة|زجاجات)"
)

# Pattern 1: "<qty> <unit> ... <price> [currency]"
#   "2 bouteilles pour 450 000 GNF"
#   "3 unités = 600,000 GNF"
#   "1 pcs à 35$"
_PATTERN_QTY_FIRST = re.compile(
    r"(\d{1,3})\s*" + _QTY_UNIT +
    r"[^0-9]{0,40}?"
    r"(\d{1,3}(?:[\s.,]\d{3})+|\d+)\s*"
    + _CURRENCY_HINT + r"?",
    re.IGNORECASE | re.UNICODE,
)

# Pattern 2 (less common): "Pack X: ... <qty> ... <price> [currency]"
# Kept as a softer fallback when the seller writes price-first sentences.
_PATTERN_PRICE_NEAR_QTY = re.compile(
    r"(\d{1,3}(?:[\s.,]\d{3})+|\d+)\s*"
    + _CURRENCY_HINT + r"\s*"
    r"[^0-9]{0,40}?"
    r"(\d{1,3})\s*" + _QTY_UNIT,
    re.IGNORECASE | re.UNICODE,
)


def _normalize_price_str(s: str) -> Optional[float]:
    """Convert "299 000" / "299,000" / "299.000" / "299000" → 299000.0.
    Returns None if the string is too short to be a real price (we use
    a 3-char minimum to filter out '12', '20', etc. that might appear
    inside descriptions as something else)."""
    if not s:
        return None
    # Drop separators (any non-digit other than a decimal point at the end)
    digits_only = re.sub(r"[\s,]", "", s)
    # If it ends with a 3-digit group preceded by a dot, treat the dot as
    # thousands separator (French "299.000"). Otherwise treat as decimal.
    m = re.fullmatch(r"(\d+)\.(\d{3})", digits_only)
    if m:
        digits_only = m.group(1) + m.group(2)
    try:
        v = float(digits_only)
    except ValueError:
        return None
    # Require >0 (skip "0 GNF" placeholders). The regex anchor already
    # constrained the digits to a price-shaped context (after a qty unit
    # and optionally followed by a currency), so we don't need a higher
    # floor — a $5 product is still a price.
    return v if v > 0 else None


def parse_prices_from_description(*texts: str) -> Dict[str, float]:
    """Scan one or more description strings for quantity → total price
    hints. Returns a {"1": 299000, "2": 450000} style dict.

    The bot lets sellers express pricing as free text in the description
    ("1 bouteille = 299 000 GNF, 2 bouteilles = 450 000 GNF" is more
    natural to type than filling a tier map in the admin UI), and this
    parser converts those mentions back into structured tiers so
    compute_total_price can quote the right total at confirmation time.

    Conservative on purpose: only accepts patterns with a clear quantity
    + unit word + price. Numbers that look ambiguous are left alone.
    """
    tiers: Dict[str, float] = {}
    for raw in texts:
        if not raw:
            continue
        # Normalize French/Arabic thin spaces used as thousand separators
        # so the regex sees plain ASCII spaces.
        text = raw.replace("\xa0", " ").replace(" ", " ")
        for m in _PATTERN_QTY_FIRST.finditer(text):
            qty_str, price_str = m.group(1), m.group(2)
            try:
                qty = int(qty_str)
            except ValueError:
                continue
            price = _normalize_price_str(price_str)
            if price and 0 < qty < 100 and str(qty) not in tiers:
                tiers[str(qty)] = price
        # Only run the fuzzier price-first pattern if we still have nothing,
        # so we don't accidentally double-match the same sentence.
        if not tiers:
            for m in _PATTERN_PRICE_NEAR_QTY.finditer(text):
                price_str, qty_str = m.group(1), m.group(2)
                try:
                    qty = int(qty_str)
                except ValueError:
                    continue
                price = _normalize_price_str(price_str)
                if price and 0 < qty < 100 and str(qty) not in tiers:
                    tiers[str(qty)] = price
    return tiers


def merge_tiers_with_description(pc: Optional[Dict], product: Optional[Dict]) -> Dict[str, float]:
    """Combine the seller's explicit price_tiers (from product_countries)
    with prices parsed from the descriptions. Explicit tiers ALWAYS win —
    the parser is a fallback for sellers who'd rather write everything
    in free text. Returns a flat {"qty_str": total_price} dict."""
    explicit = (pc or {}).get("price_tiers") or {}
    explicit_clean: Dict[str, float] = {}
    if isinstance(explicit, dict):
        for k, v in explicit.items():
            try:
                qty = int(k)
                price = float(v)
                if qty > 0 and price > 0:
                    explicit_clean[str(qty)] = price
            except (TypeError, ValueError):
                continue
    parsed = parse_prices_from_description(
        (pc or {}).get("translated_description") or "",
        (product or {}).get("description") or "",
    )
    # Merge: parsed first, then explicit overrides.
    merged: Dict[str, float] = {}
    merged.update(parsed)
    merged.update(explicit_clean)
    return merged


def compute_total_price(quantity: int, pc: Optional[Dict],
                        product: Optional[Dict] = None) -> Tuple[float, float]:
    """Look up the total price for `quantity` units. Returns
    (total_price, effective_unit_price).

    Resolution order:
      1. price_tiers[str(quantity)] in product_countries — explicit bulk
         price set by the seller via the admin UI.
      2. Same key parsed from the description text (when the seller
         wrote pricing like "2 bouteilles = 450 000 GNF" instead of
         filling structured fields).
      3. quantity * product_countries.price — multiply the single-unit
         price as a fallback.
      4. If even the unit price is 0 but the description mentions a
         "1 unit = X" line, infer the unit from there too.
    """
    qty = max(1, int(quantity or 1))
    unit = float((pc or {}).get("price") or 0)
    merged_tiers = merge_tiers_with_description(pc, product)

    # 1. Exact tier hit (e.g. "4 bouteilles -> 900 000 GNF" set explicitly).
    tier_total = merged_tiers.get(str(qty))
    if tier_total is not None:
        try:
            total = float(tier_total)
            eff_unit = round(total / qty, 2) if qty else total
            return (round(total, 2), eff_unit)
        except (TypeError, ValueError):
            pass

    # Parse all tier sizes (skip 1-pack — that's effectively the unit price).
    sized_tiers: List[Tuple[int, float]] = []
    for k, v in merged_tiers.items():
        try:
            n = int(k)
            p = float(v)
            if n >= 2 and p > 0:
                sized_tiers.append((n, p))
        except (TypeError, ValueError):
            continue
    sized_tiers.sort(key=lambda kv: kv[0])

    # Unit-from-description fallback when product_countries.price is 0.
    if unit <= 0 and merged_tiers.get("1") is not None:
        try:
            unit = float(merged_tiers["1"])
        except (TypeError, ValueError):
            unit = 0.0

    # 2. Best-pack combination: greedily pick the largest tier that fits,
    # apply it as many times as possible, then add unit price for leftovers.
    # Example: qty=4 with tier_2=450k → 2 packs × 450k = 900k.
    # Example: qty=5 with tier_2=450k → 2 packs × 450k + 1 × 299k = 1 199k.
    # Example: qty=3 with tier_2=450k → 1 pack × 450k + 1 × 299k = 749k.
    if sized_tiers and qty >= 2:
        best_total: Optional[float] = None
        for pack_qty, pack_price in sized_tiers:
            if pack_qty > qty:
                continue
            packs = qty // pack_qty
            leftover = qty - packs * pack_qty
            combo = packs * pack_price + leftover * unit
            if best_total is None or combo < best_total:
                best_total = combo
        if best_total is not None:
            eff_unit = round(best_total / qty, 2) if qty else best_total
            return (round(best_total, 2), eff_unit)

    # 3. Pure unit-price fallback (no tiers configured at all).
    return (round(unit * qty, 2), unit)


def _format_tier_offers(pc: Optional[Dict], product: Optional[Dict] = None) -> str:
    """Render the available bulk-pricing offers as a bullet list for the
    LLM prompt. Bot uses this in Stage 4 so it can advertise the same
    offers the seller would (e.g. "1 bouteille à 299 000 GNF · 2 bouteilles
    à 450 000 GNF (économie 148 000)"). Includes any tiers parsed from
    the description so a seller who wrote prices in free text still gets
    structured offers in the prompt."""
    merged_tiers = merge_tiers_with_description(pc, product)
    if not merged_tiers:
        return ""
    unit = float((pc or {}).get("price") or 0)
    if unit <= 0:
        try:
            unit = float(merged_tiers.get("1") or 0)
        except (TypeError, ValueError):
            unit = 0.0
    currency = (pc or {}).get("currency") or ""
    rows = []
    for qty_str, total in sorted(merged_tiers.items(),
                                 key=lambda kv: int(kv[0]) if str(kv[0]).isdigit() else 999):
        try:
            qty = int(qty_str)
            total_f = float(total)
        except (TypeError, ValueError):
            continue
        regular = unit * qty
        if unit > 0 and regular > total_f:
            savings = regular - total_f
            rows.append(f"  • {qty} units → {total_f:g} {currency} (regular {regular:g}, save {savings:g})")
        else:
            rows.append(f"  • {qty} units → {total_f:g} {currency}")
    return "\n".join(rows)


def _order_signature(pending: Dict, product_id: Optional[str],
                     custom_fields: Optional[List[Dict]] = None) -> str:
    """Stable short hash of the customer + product + quantity for this
    order. Used as an idempotency key: two pushes for the same conversation
    with the same name/address/city/quantity/product produce the same
    signature → second push is suppressed (handles the "wakha / merci /
    yes confirmé" follow-ups that the LLM treats as another
    ready_to_order intent).

    A genuine second order (different quantity, different address) yields
    a different signature and goes through.

    For a service with a seller-defined custom_fields schema (migration
    0012), name/address/city may be empty by design — so we hash the custom
    field VALUES instead, otherwise every booking on that service would
    collapse to the same signature and the second one would be dropped.
    """
    import hashlib
    if not pending:
        return ""
    if custom_fields:
        parts = [str(pending.get(f["key"]) or "").strip().lower()
                 for f in custom_fields]
        parts.append(str(product_id or ""))
    else:
        parts = [
            str(pending.get("name") or "").strip().lower(),
            str(pending.get("address") or "").strip().lower(),
            str(pending.get("city") or "").strip().lower(),
            str(pending.get("quantity") or "").strip() if isinstance(pending.get("quantity"), str) else str(pending.get("quantity") or ""),
            str(product_id or ""),
        ]
    raw = "|".join(parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def build_and_push_order(seller: Dict, product: Optional[Dict],
                         pc: Optional[Dict], conversation: Dict,
                         from_jid: str, country_code: str,
                         pending: Dict) -> Optional[Dict]:
    """Insert an `orders` row and push to whichever Sheets webhook is
    configured. Returns the inserted row (or None on failure). The phone
    number comes from pending.phone (which was seeded from the bridge's
    sender_pn or, failing that, the @s.whatsapp.net JID digits)."""
    if not (seller and product and pending):
        return None

    # pending.phone was set in the webhook from sender_pn (preferred — real
    # number for LIDs) or from the JID (works for @s.whatsapp.net). Fall
    # back to jid_to_phone for the rare case the pending was reset.
    phone_from_jid = (pending.get("phone") or "").strip() or jid_to_phone(from_jid)
    # For services we never collect a quantity — every booking is "1
    # appointment" by default. Force quantity=1 so the orders row stays
    # consistent and the seller's sheet gets a sane number.
    is_service = ((product or {}).get("kind") or "product").lower() == "service"
    quantity = 1 if is_service else int(pending.get("quantity") or 1)
    currency = (pc or {}).get("currency") or ""
    total_price, unit_price = compute_total_price(quantity, pc, product)

    order_row = {
        "seller_id": seller["id"],
        "conversation_id": conversation["id"],
        "product_id": product["id"],
        "customer_jid": from_jid,
        "customer_name": pending.get("name") or "",
        "customer_phone": phone_from_jid,
        "customer_address": pending.get("address") or "",
        "customer_city": pending.get("city") or "",
        "quantity": quantity,
        "unit_price": unit_price,
        "total_price": total_price,
        "currency": currency,
        "country_code": country_code,
        "status": "pending",
        "sheets_sync_status": "pending",
    }
    inserted = _supa_post("orders", order_row)
    if not inserted:
        log.warning("[order] insert failed for conversation %s", conversation["id"])
        return None

    # Sheet payload — keys + order MUST match the seller's spreadsheet
    # column headers exactly (sku, Customer_Name, Phone, address,
    # Quantity, total_price). Apps Script Web Apps that use
    # `e.postData.contents` and a `headers.forEach(h => row.push(data[h]))`
    # pattern rely on this. Extra keys (id, country, currency, …) are
    # appended after the canonical six so they're available to richer
    # Apps Scripts without breaking simple column-mapped ones.
    address_combined = (
        (pending.get("address") or "").strip()
        + (", " + (pending.get("city") or "").strip() if pending.get("city") else "")
    ).strip(", ").strip()
    sheet_payload = {
        # sku is left empty by design — the seller fills it with their own
        # ERP / catalogue SKU in the sheet. Brain just provides the data
        # rows; the product identity is preserved by Customer_Name + Phone.
        "sku":           "",
        "Customer_Name": pending.get("name") or "",
        "Phone":         phone_from_jid or "",
        "address":       address_combined,
        "Quantity":      quantity,
        # Plain number — the seller's sheet has its own currency formatting,
        # so we send the raw amount and let Google Sheets format the cell
        # (or let the seller display the currency in a separate column).
        "total_price":   total_price,
        # Extras — placed after the canonical six so column-ordered Apps
        # Scripts don't pick them up by mistake, but they're available to
        # any script that reads by key.
        "id":           inserted.get("id"),
        "currency":     currency,
        "country_code": country_code,
        "customer_jid": from_jid,
        "created_at":   inserted.get("created_at"),
    }
    if is_service:
        # Service bookings carry extra columns the seller's sheet may
        # want to render. Apps Scripts that only map the canonical six
        # columns won't notice; scripts that look up by key (most modern
        # ones) will pick these up and display the booking date/notes.
        sheet_payload["service_date"] = pending.get("service_date") or ""
        sheet_payload["notes"]        = pending.get("notes") or ""
        sheet_payload["kind"]         = "service"
        # Universal custom fields (migration 0012): emit every seller-defined
        # field under its own key so a key-mapped Apps Script renders the
        # full booking (e.g. car_type, nombre_de_jours, motif_consultation).
        for f in normalize_custom_fields(product):
            sheet_payload.setdefault(f["key"], pending.get(f["key"]) or "")

    # 2-Agent SaaS pipeline extras — Agent 1 stamped a `lead_priority`
    # + `bot_internal_notes` on `pending` before this push fired. We
    # emit them alongside the canonical columns + also under a clean
    # SaaS-spec dict (item_name / customer_name / phone / localized_details
    # / status / lead_priority / internal_notes) that the dashboard's
    # XLSX exporter can consume verbatim. Sellers see hot-vs-doubtful
    # at a glance + the reason in the notes column.
    if pending.get("lead_priority"):
        sheet_payload["lead_priority"] = pending["lead_priority"]
    if pending.get("bot_internal_notes"):
        sheet_payload["bot_internal_notes"] = pending["bot_internal_notes"]
    # Compose `localized_details` — a single readable string so a
    # spreadsheet column can show address + city + qty in one cell.
    bits = []
    if pending.get("address"):
        bits.append(pending["address"])
    if pending.get("city"):
        bits.append(pending["city"])
    if not is_service and pending.get("quantity"):
        bits.append(f"x{pending['quantity']}")
    if is_service and pending.get("service_date"):
        bits.append(f"@{pending['service_date']}")
    sheet_payload["localized_details"] = " · ".join(bits)
    sheet_payload["item_name"] = (product or {}).get("name") or ""
    pushed = push_order_to_sheet(seller, product, sheet_payload)
    if pushed:
        _supa_patch("orders", {"id": inserted["id"]}, {
            "sheets_sync_status": "synced",
            "sheets_sync_at": datetime.now(timezone.utc).isoformat(),
        })
    else:
        _supa_patch("orders", {"id": inserted["id"]}, {
            "sheets_sync_status": "failed",
        })

    # Reset the conversation so the SAME customer can place a SECOND
    # order later without the old "status==order_placed" guard blocking
    # it forever. We:
    #   • record the signature of THIS order on pending so subsequent
    #     "yes / wakha / merci" follow-up messages can be deduped (the
    #     LLM re-extracts the same fields from history → identical sig)
    #   • flip status back to 'active' so the bot resumes normal sales
    #     flow when the customer engages again (and a real second order
    #     with different fields will produce a different sig → push).
    sig = _order_signature(pending, product.get("id"))
    new_pending = dict(pending)
    new_pending["last_order_sig"] = sig
    new_pending["last_order_at"] = datetime.now(timezone.utc).isoformat()
    _supa_patch("customer_conversations", {"id": conversation["id"]}, {
        "status": "active",
        "pending_order_fields": new_pending,
    })
    return inserted


# ── Outbound helper (proactive messages — not used for synchronous replies) ─
def send_outbound(seller_id: str, jid: str, text: str) -> bool:
    if not (jid and text):
        return False
    try:
        r = httpx.post(BRIDGE_SEND_URL, json={
            "seller_id": seller_id,
            "jid": jid,
            "text": text,
        }, timeout=15)
        return r.status_code in (200, 201)
    except Exception as exc:
        log.warning("[outbound] send failed: %s", exc)
        return False


# ── OpenWA REST client ───────────────────────────────────────────────────
# OpenWA exposes the live whatsapp-web.js session over an HTTP API. Brain
# uses it for two things:
#   1. Listening for inbound messages via OpenWA's webhook (it POSTs to
#      our /openwa/webhook endpoint).
#   2. Sending outbound replies via POST /api/sessions/{id}/messages/send-text.
#
# Auth is a single X-API-Key header. The session ID identifies which
# paired WhatsApp account to act on — for a single-seller MVP this is
# hardcoded in .env (OPENWA_SESSION_ID).

def _openwa_headers(api_key: Optional[str] = None) -> Dict[str, str]:
    return {
        "X-API-Key": api_key or OPENWA_API_KEY,
        "Content-Type": "application/json",
    }


def _resolve_openwa_config(seller: Optional[Dict]) -> Tuple[str, str, str]:
    """Return (api_url, api_key, session_id) for this seller, falling back
    to the env-var defaults when the seller's row doesn't have an override.
    Each seller can run on a different OpenWA instance (or share one)."""
    s = seller or {}
    api_url = (s.get("openwa_api_url") or OPENWA_API_URL or "").rstrip("/")
    api_key = s.get("openwa_api_key") or OPENWA_API_KEY or ""
    session_id = s.get("openwa_session_id") or OPENWA_SESSION_ID or ""
    return (api_url, api_key, session_id)


def openwa_normalize_jid(jid_or_phone: str) -> str:
    """OpenWA / whatsapp-web.js uses '<digits>@c.us' for contacts and
    '<digits>@g.us' for groups. Strip any extras and return the bare JID
    in the c.us form that the REST API accepts as `to`."""
    if not jid_or_phone:
        return ""
    s = jid_or_phone.strip()
    if "@" in s:
        user = s.split("@", 1)[0]
    else:
        user = s.lstrip("+")
    user = user.split(":", 1)[0]
    digits = re.sub(r"\D+", "", user)
    return f"{digits}@c.us" if digits else ""


def _looks_like_real_phone(digits: str) -> bool:
    """Heuristic: a real WhatsApp phone is 8-15 digits and parses cleanly
    via libphonenumber. LID-only contacts arrive as long digit strings
    (often 14+) that don't correspond to any real country/regional code."""
    if not digits or not digits.isdigit():
        return False
    if not (8 <= len(digits) <= 15):
        return False
    try:
        parsed = phonenumbers.parse("+" + digits, None)
        return phonenumbers.is_valid_number(parsed)
    except Exception:
        return False


def _curl_post_json(url: str, headers: Dict[str, str], payload: Dict,
                    timeout_s: float) -> Tuple[int, str]:
    """POST JSON via the native curl.exe binary, returning (status, body).

    Why this exists: on some Windows boxes Avast's Behaviour Shield
    sandboxes python.exe specifically and blocks its outbound socket to
    localhost:2785 (OpenWA) with `[Errno 13] Permission denied:
    '\\\\.\\aswMonFltProxy\\...'`, while Microsoft-signed binaries like
    curl.exe (shipped in System32 since Win10 1803) reach the exact same
    port fine. So when httpx is blocked we re-issue the identical request
    through curl.exe and the reply still gets out.
    """
    exe = shutil.which("curl") or r"C:\Windows\System32\curl.exe"
    marker = "\nHTTPSTATUS:"
    args = [exe, "-sS", "-m", str(int(max(1, timeout_s))),
            "-X", "POST", url, "-w", marker + "%{http_code}"]
    for k, v in headers.items():
        args += ["-H", f"{k}: {v}"]
    args += ["--data-binary", json.dumps(payload)]
    proc = subprocess.run(args, capture_output=True, text=True,
                          timeout=timeout_s + 5)
    out = proc.stdout or ""
    idx = out.rfind(marker)
    if idx >= 0:
        body = out[:idx]
        code_str = out[idx + len(marker):].strip()
    else:
        body, code_str = out, ""
    try:
        code = int(code_str)
    except ValueError:
        code = 0
    if code == 0:
        # curl never got an HTTP response (DNS, connect, transport error).
        raise RuntimeError(
            f"curl exit {proc.returncode}: {(proc.stderr or out or '')[:200]}")
    return code, body


def _openwa_post_send_text(session_id: str, chat_id: str, text: str,
                           api_url: Optional[str] = None,
                           api_key: Optional[str] = None,
                           typing_ms: int = 0,
                           mark_seen: bool = True) -> Tuple[bool, str]:
    """Single send attempt. Returns (ok, body) — `ok` is True only when
    OpenWA replies with a 2xx AND the persisted message status comes back
    as anything other than 'failed' (best-effort check).

    typing_ms / mark_seen drive the human-presence sequence: blue ticks
    on the inbound message, then "typing..." for typing_ms before the
    reply actually lands. Defaults to off so non-bot callers (Message
    Tester, plugins) keep instant-send behaviour.
    """
    base = (api_url or OPENWA_API_URL).rstrip("/")
    url = f"{base}/api/sessions/{session_id}/messages/send-text"
    payload = {
        "chatId": chat_id,
        "text": text,
        "typingMs": int(max(0, typing_ms)),
        "markSeen": bool(mark_seen),
    }
    # OpenWA waits server-side for typing_ms before sending, so we extend
    # the HTTP timeout accordingly (typing window + 15s networking budget).
    timeout = 15 + max(0, typing_ms) / 1000.0
    try:
        r = httpx.post(
            url,
            headers=_openwa_headers(api_key),
            json=payload,
            timeout=timeout,
        )
        ok_http = r.status_code in (200, 201, 202)
        body = r.text[:400] if r.text else ""
        # When whatsapp-web.js refuses ("No LID for user", "Chat not
        # found", etc.) OpenWA still returns 201 with the persisted row
        # carrying status:"failed". Detect that so we can retry.
        if ok_http and '"status":"failed"' in body:
            return (False, body)
        return (ok_http, body)
    except Exception as exc:
        # httpx failed at the transport layer. If it looks like Avast's
        # python.exe socket sandbox (or any connect-time block), retry the
        # IDENTICAL request through curl.exe, which the AV doesn't sandbox.
        # We deliberately do NOT fall back on read-timeouts: those mean
        # OpenWA actually received the request but is slow, so a curl retry
        # would risk a duplicate send. A connect/permission error means the
        # request never left the box, so curl is safe.
        msg = str(exc).lower()
        connect_blocked = any(s in msg for s in (
            "aswmonfltproxy", "[errno 13]", "permission denied",
            "winerror 10013", "connecterror", "connection refused",
            "connection reset", "connect call failed", "failed to establish",
        )) and "timeout" not in msg
        if connect_blocked:
            try:
                code, cbody = _curl_post_json(
                    url, _openwa_headers(api_key), payload, timeout)
                ok_http = code in (200, 201, 202)
                cbody = (cbody or "")[:400]
                if ok_http and '"status":"failed"' in cbody:
                    return (False, cbody)
                if ok_http:
                    log.info("[openwa] ✓ curl.exe fallback delivered "
                             "(httpx blocked: %s)", str(exc)[:80])
                return (ok_http, cbody or f"curl http {code}")
            except Exception as cexc:
                return (False, f"httpx:{exc} | curl:{cexc}")
        return (False, str(exc))


# Cache LID → real-phone lookups for the lifetime of the process. WhatsApp
# Web's contact directory rarely changes mid-session, and a customer's
# LID maps 1:1 to their underlying phone — so caching is safe and saves
# us one HTTP round-trip per inbound message.
_LID_PHONE_CACHE: Dict[str, str] = {}


def openwa_resolve_phone_for_jid(jid: str,
                                 session_id: Optional[str] = None,
                                 api_url: Optional[str] = None,
                                 api_key: Optional[str] = None) -> str:
    """Ask OpenWA for the real phone number behind a privacy-restricted
    @lid JID. Returns '' if OpenWA doesn't know the mapping (rare —
    happens only for customers we've never previously chatted with on
    that WhatsApp account).

    Same call works for @c.us JIDs too (the contact endpoint just echoes
    the phone back), so the caller can use this uniformly without first
    sniffing the JID format.
    """
    if not jid:
        return ""
    if jid in _LID_PHONE_CACHE:
        return _LID_PHONE_CACHE[jid]

    sid = (session_id or OPENWA_SESSION_ID or "").strip()
    base = (api_url or OPENWA_API_URL or "").rstrip("/")
    key = (api_key or OPENWA_API_KEY or "").strip()
    if not (sid and base and key):
        return ""

    # OpenWA expects the URL-encoded chat-id. The contact endpoint accepts
    # both @lid and @c.us forms; for LIDs the underlying phone comes back
    # in the `number` field as a libphonenumber-formatted E.164 string.
    contact_id = urllib.parse.quote(jid, safe="")
    url = f"{base}/api/sessions/{sid}/contacts/{contact_id}"
    try:
        r = httpx.get(url, headers=_openwa_headers(key), timeout=8)
        if r.status_code != 200:
            return ""
        c = r.json() or {}
        # OpenWA's response shape (confirmed against the running gateway):
        #   id      → "<phone>@c.us"  ← the real, dialable phone for LIDs
        #   number  → "<lid_digits>"   ← the LID digits, NOT a real phone
        #   name / pushName → contact display
        # whatsapp-web.js: for a LID contact, `contact.id._serialized`
        # echoes the underlying @c.us address while `contact.number`
        # echoes the LID. So we prefer `id`.
        cand_digits = ""
        raw_id = c.get("id")
        # Handle both string and dict shapes (different wwebjs / OpenWA versions).
        id_serialized = ""
        if isinstance(raw_id, str):
            id_serialized = raw_id
        elif isinstance(raw_id, dict):
            id_serialized = raw_id.get("_serialized") or ""
        if id_serialized and "@c.us" in id_serialized:
            cand_digits = re.sub(r"\D+", "", id_serialized.split("@", 1)[0])
        # Fallback to the `number` field only when `id` didn't give us a
        # @c.us-shaped value (defensive — not seen in current OpenWA).
        if not cand_digits:
            num = (c.get("number") or "").strip()
            cand_digits = re.sub(r"\D+", "", num)
        if cand_digits and _looks_like_real_phone(cand_digits):
            real = "+" + cand_digits
            _LID_PHONE_CACHE[jid] = real
            return real
    except Exception as exc:
        log.warning("[openwa] contact lookup for %s failed: %s", jid, exc)
    return ""


def _human_typing_ms(text: str) -> int:
    """Believable composition time for `text`. Mirrors what a person on
    WhatsApp actually does, but tuned snappy so customers don't perceive
    the bot as stuck: ~1.2s base "thinking" pause, then ~30ms per
    character (≈35 WPM — typical fast-thumb mobile typing) with a ±25%
    jitter so the bot doesn't repeat the exact same cadence on every
    reply. Clamped [1.0s, 5.5s] so short replies arrive almost immediately
    and even very long ones don't keep the customer waiting more than
    a few seconds for the "typing..." indicator to clear.

    Previously this was capped at 12s and customers reported the bot
    feeling slow — at 12s of "typing..." they'd send a second message
    thinking the bot ghosted them. 5.5s feels brisk while still keeping
    the reply human (an instant reply would look like a script).
    """
    import random
    chars = len(text or "")
    raw_ms = 1200 + chars * 30
    jittered = raw_ms * random.uniform(0.75, 1.25)
    return int(max(1000, min(5500, jittered)))


def openwa_send_image(to_jid: str, image_url: str,
                      caption: str = "",
                      session_id: Optional[str] = None,
                      api_url: Optional[str] = None,
                      api_key: Optional[str] = None) -> bool:
    """POST to OpenWA's send-image endpoint. Same JID-format fallback
    logic as openwa_send_text (real phone → @c.us, opaque LID → @lid).

    Used by the product-gallery path to send supplementary product
    photos to customers right after the bot first describes the product.
    Failures are non-fatal — we log and move on, the customer still
    gets the text reply.
    """
    if not (to_jid and image_url):
        return False
    key = (api_key or OPENWA_API_KEY or "").strip()
    sid = (session_id or OPENWA_SESSION_ID or "").strip()
    if not (key and sid):
        return False

    base = (api_url or OPENWA_API_URL).rstrip("/")
    raw_user = to_jid.split("@", 1)[0].split(":", 1)[0]
    digits = re.sub(r"\D+", "", raw_user)
    is_lid_hint = ("@lid" in to_jid.lower()) or (not _looks_like_real_phone(digits))
    candidates = [f"{digits}@lid", f"{digits}@c.us"] if is_lid_hint \
                 else [f"{digits}@c.us", f"{digits}@lid"]

    for chat_id in candidates:
        try:
            r = httpx.post(
                f"{base}/api/sessions/{sid}/messages/send-image",
                headers=_openwa_headers(key),
                json={"chatId": chat_id, "url": image_url, "caption": caption or ""},
                timeout=30,
            )
            if r.status_code in (200, 201, 202):
                # Mirror the send-text "soft fail" detection: a 2xx with
                # status:"failed" in body means whatsapp-web.js rejected
                # the recipient even though OpenWA persisted the row.
                if '"status":"failed"' in (r.text or ""):
                    log.warning("[openwa] image rejected for %s — trying next JID", chat_id)
                    continue
                log.info("[openwa] ✓ sent image to %s", chat_id)
                return True
            log.warning("[openwa] image send to %s → HTTP %s", chat_id, r.status_code)
        except Exception as exc:
            log.warning("[openwa] image send exception for %s: %s", chat_id, exc)
    return False


def openwa_send_text(to_jid: str, text: str,
                     session_id: Optional[str] = None,
                     api_url: Optional[str] = None,
                     api_key: Optional[str] = None,
                     human_like: bool = True) -> bool:
    """POST to OpenWA's send-text endpoint. Tries the most likely chat-id
    format first and falls back to alternates when WhatsApp Web rejects
    the recipient. When `human_like` is true (default for bot replies)
    we also drive WhatsApp's "seen" + "typing..." indicators for a
    realistic delivery feel.

    Background: customers using the privacy-restricted "Linked ID" flow
    arrive in the inbound webhook as `<lid_digits>@c.us`, but sending to
    that exact JID fails with "No LID for user". The same user accepts
    sends to `<lid_digits>@lid`. We pick the format by checking whether
    the digits look like a real phone (libphonenumber-validatable) —
    real phones → @c.us, opaque LIDs → @lid."""
    if not (to_jid and text):
        return False
    key = (api_key or OPENWA_API_KEY or "").strip()
    if not key:
        log.warning("[openwa] api key missing — cannot send")
        return False
    sid = (session_id or OPENWA_SESSION_ID or "").strip()
    if not sid:
        log.warning("[openwa] no session_id provided / configured")
        return False

    raw_user = to_jid.split("@", 1)[0].split(":", 1)[0]
    digits = re.sub(r"\D+", "", raw_user)
    is_lid_hint = ("@lid" in to_jid.lower()) or (not _looks_like_real_phone(digits))

    # Candidate JID formats, ordered by best-guess first.
    candidates = []
    if is_lid_hint:
        candidates.append(f"{digits}@lid")
        candidates.append(f"{digits}@c.us")
    else:
        candidates.append(f"{digits}@c.us")
        candidates.append(f"{digits}@lid")

    typing_ms = _human_typing_ms(text) if human_like else 0
    # Retry-on-500 budget: OpenWA's whatsapp-web.js sometimes blips with
    # an Internal Server Error when Chromium is mid-task (sync'ing a
    # message store, rebooting a stale tab, etc.). The next attempt
    # 2-3s later usually succeeds. Without this retry the customer
    # silently never gets the bot's reply — the worst possible UX.
    for chat_id in candidates:
        last_body = ""
        for attempt in range(3):
            ok, body = _openwa_post_send_text(
                sid, chat_id, text,
                api_url=api_url, api_key=key,
                typing_ms=typing_ms if attempt == 0 else 0,  # only type once
                mark_seen=human_like and attempt == 0,
            )
            if ok:
                log.info("[openwa] ✓ sent to %s (%d chars, typing=%dms, "
                         "attempt %d)", chat_id, len(text), typing_ms,
                         attempt + 1)
                return True
            last_body = body
            # 500 from OpenWA = transient Chromium glitch, retry with
            # backoff. 4xx (bad recipient / unauthorized) is permanent
            # for this JID format — break and try the next candidate.
            # Also retry on Windows socket errors from Avast's
            # aswMonFltProxy filter, which periodically blocks localhost
            # HTTP to OpenWA for 1-3s windows before relaxing — exactly
            # the cadence a small retry recovers from.
            body_lower = body.lower()
            transient = (
                "500" in body[:30]
                or "internal server error" in body_lower
                or "econnrefused" in body_lower
                or "timeout" in body_lower
                or "aswmonfltproxy" in body_lower
                or "[errno 13]" in body_lower
                or "permission denied" in body_lower
                or "connection reset" in body_lower
                or "connectionreseterror" in body_lower
            )
            if not transient:
                break
            log.warning("[openwa] send to %s failed (attempt %d, transient) · %s",
                        chat_id, attempt + 1, body[:160])
            time.sleep(1.5 * (attempt + 1))  # 1.5s, 3s before next try
        log.warning("[openwa] send to %s failed · %s", chat_id, last_body[:200])
    return False


def _webhook_base() -> str:
    """The brain's externally-reachable base URL that the OpenWA gateway POSTs
    inbound messages to. Mirrors the boot-time priority order so a per-seller
    session webhook resolves to the same callback as the OPENWA_SESSION_ID one."""
    if PUBLIC_BASE_URL:
        return PUBLIC_BASE_URL
    _rail = os.environ.get("RAILWAY_PRIVATE_DOMAIN")
    if _rail:
        return f"http://{_rail}:{PORT}"
    if os.environ.get("OPENWA_INSIDE_DOCKER"):
        return f"http://host.docker.internal:{PORT}"
    return f"http://127.0.0.1:{PORT}"


def _ensure_session_webhook(session_id: str) -> None:
    """Best-effort, non-blocking: make sure OpenWA pipes `session_id`'s inbound
    messages to our /openwa/webhook. The gateway stores webhooks PER SESSION, so
    a freshly-claimed seller session is connected but SILENT until this runs —
    this is what lets the bot actually reply for multi-tenant seller numbers
    (not just the single hardcoded OPENWA_SESSION_ID)."""
    sid = (session_id or "").strip()
    if not (sid and OPENWA_API_KEY):
        return
    cb = f"{_webhook_base()}/openwa/webhook"
    threading.Thread(target=lambda: openwa_register_webhook(cb, sid), daemon=True).start()


def openwa_register_webhook(callback_url: str, session_id: str = "") -> bool:
    """Idempotently register `callback_url` as the message.received webhook for
    `session_id` (falls back to OPENWA_SESSION_ID). Called at brain startup for
    the configured session AND per seller-session on claim, so OpenWA pipes
    inbound messages to /openwa/webhook without manual dashboard clicks."""
    sid = (session_id or OPENWA_SESSION_ID or "").strip()
    if not (sid and OPENWA_API_KEY and callback_url):
        return False
    try:
        existing = httpx.get(
            f"{OPENWA_API_URL}/api/webhooks",
            headers=_openwa_headers(),
            params={"sessionId": sid},
            timeout=15,
        ).json() or []
        for w in (existing if isinstance(existing, list) else []):
            if (w.get("url") or "").rstrip("/") == callback_url.rstrip("/"):
                log.info("[openwa] webhook already registered (id=%s)", w.get("id"))
                return True
        r = httpx.post(
            f"{OPENWA_API_URL}/api/sessions/{sid}/webhooks",
            headers=_openwa_headers(),
            json={"url": callback_url, "events": ["message.received"]},
            timeout=15,
        )
        if r.status_code in (200, 201):
            log.info("[openwa] ✓ webhook registered: %s", callback_url)
            return True
        log.warning("[openwa] register webhook → HTTP %s · %s",
                    r.status_code, r.text[:200])
        return False
    except Exception as exc:
        log.warning("[openwa] register webhook exception: %s", exc)
        return False


def openwa_resolve_seller_id(session_id: str,
                             bot_pn: Optional[str] = None) -> Optional[str]:
    """Map an OpenWA session_id to a leadecombot seller_id.

    `bot_pn` is the bot's OWN phone number (digits only), taken from the
    inbound webhook's `to` field. It's the stable anchor that lets us
    survive OpenWA's volatile session UUIDs (see step 3).

    Lookup priority:
      1. sellers row whose `openwa_session_id` column matches (the
         per-seller Settings → WhatsApp gateway config). This is the
         canonical multi-tenant path.
      2. seller_whatsapp_sessions row whose `jid` stores the OpenWA
         session UUID (the fast path once a number is wired up).
      3. SELF-HEAL by phone: re-pairing / recreating an OpenWA session
         mints a brand-new UUID, which silently orphans the jid mapping
         in (2) and drops every inbound message. The bot's own phone is
         stable, so we match seller_whatsapp_sessions.phone == bot_pn and
         rewrite the stale jid to the live UUID — the fast path works
         again from the next message on, no manual SQL needed.
      4. For a single-seller install, fall back to the lone seller.
      5. Single-tenant-by-usage: if exactly ONE seller has ever paired a
         WhatsApp number, route to it (and auto-register this number),
         even when other seller rows exist but have no WhatsApp yet.
    """
    if not session_id:
        return None
    bot_pn = re.sub(r"\D+", "", bot_pn or "") or None
    # (1) New canonical: sellers.openwa_session_id (no-op if migration
    # 0004 hasn't been applied — _supa_get swallows the schema 400 silently).
    try:
        rows = _supa_get("sellers", {
            "openwa_session_id": f"eq.{session_id}",
            "select": "id",
            "limit": "1",
        })
        if rows:
            return rows[0].get("id")
    except Exception:
        pass
    # (2) Fast path: seller_whatsapp_sessions.jid == live UUID.
    rows = _supa_get("seller_whatsapp_sessions", {
        "jid": f"eq.{session_id}",
        "select": "seller_id",
        "limit": "1",
    })
    if rows:
        return rows[0].get("seller_id")
    # (3) Self-heal by the bot's own (stable) phone number.
    if bot_pn:
        rows = _supa_get("seller_whatsapp_sessions", {
            "phone": f"eq.{bot_pn}",
            "select": "seller_id,jid",
            "limit": "1",
        })
        if rows:
            seller_id = rows[0].get("seller_id")
            if rows[0].get("jid") != session_id:
                healed = _supa_patch(
                    "seller_whatsapp_sessions",
                    {"phone": bot_pn},
                    {
                        "jid": session_id,
                        "status": "connected",
                        "last_seen_at": datetime.now(timezone.utc).isoformat(),
                    },
                )
                log.info("[openwa] self-healed jid for +%s → %s (%s)",
                         bot_pn, session_id,
                         "ok" if healed else "patch-failed")
            return seller_id
    # (4) Single-seller install fallback.
    sellers = _supa_get("sellers", {"select": "id", "limit": "2"})
    if len(sellers) == 1:
        return sellers[0].get("id")
    # (5) Single-tenant-by-usage: only ONE seller owns any WhatsApp number.
    ws = _supa_get("seller_whatsapp_sessions", {"select": "seller_id"})
    distinct = {r.get("seller_id") for r in ws if r.get("seller_id")}
    if len(distinct) == 1:
        only = next(iter(distinct))
        # Auto-register this freshly-paired number so the dashboard picker
        # shows it and future inbound resolves via the fast path (2).
        if bot_pn:
            _supa_post("seller_whatsapp_sessions", {
                "seller_id": only,
                "phone": bot_pn,
                "jid": session_id,
                "status": "connected",
                "paired_at": datetime.now(timezone.utc).isoformat(),
                "last_seen_at": datetime.now(timezone.utc).isoformat(),
            }, prefer="return=minimal")
            log.info("[openwa] auto-registered +%s → seller %s (session %s)",
                     bot_pn, only, session_id)
        return only
    return None


# ── HTTP routes ──────────────────────────────────────────────────────────
def _cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


@app.route("/health", methods=["GET"])
def health():
    return _cors(jsonify({
        "ok": True,
        "model": get_openrouter_model(),
        "openrouter_configured": bool(get_openrouter_key()),
        "supabase_configured": bool(SUPABASE_URL and SUPABASE_SERVICE_KEY),
        "phase": "0-bootstrap",
    }))


_WA_STATUS_CACHE: Dict[str, Tuple[float, Dict]] = {}
_WA_STATUS_TTL_S = 5.0  # short cache so the badge feels live but we don't slam OpenWA


@app.route("/wa/status", methods=["GET", "OPTIONS"])
def wa_status():
    """Unified WhatsApp connection status the admin UI can poll. Looks up
    the OpenWA session and translates its state into the same shape the
    legacy Baileys bridge used to return, so AdminWhatsappPage just works.

    A 5-second in-memory cache prevents dashboard polls (every 5s in the
    admin UI) from blowing through OpenWA's request throttler — which
    previously returned 429s and made the badge show "unknown" even
    though the session was healthy."""
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    sid = OPENWA_SESSION_ID
    if not (sid and OPENWA_API_KEY):
        return _cors(jsonify({
            "ok": True, "status": "not_configured", "transport": "openwa",
            "jid": None, "phone": None,
        }))
    # Serve from cache if fresh.
    cached = _WA_STATUS_CACHE.get(sid)
    if cached:
        ts, payload = cached
        if time.time() - ts < _WA_STATUS_TTL_S:
            return _cors(jsonify(payload))
    try:
        r = httpx.get(
            f"{OPENWA_API_URL}/api/sessions/{sid}",
            headers=_openwa_headers(), timeout=10,
        )
        if r.status_code != 200:
            # If OpenWA throttled us (429) and we have a stale cache entry,
            # return that instead of "unknown" — the session almost
            # certainly hasn't changed in the last few seconds and the
            # dashboard badge flickering between "connected" and "unknown"
            # is far worse UX than serving slightly old data.
            if cached:
                _ts_stale, stale = cached
                return _cors(jsonify({**stale, "cached": True,
                                      "cache_age_s": int(time.time() - _ts_stale)}))
            # Even with no cache (cold start while OpenWA is throttled),
            # store an "unknown" placeholder so the *next* poll within
            # the TTL window doesn't slam OpenWA again. Without this,
            # back-to-back dashboard polls during a throttler burst
            # each re-hit OpenWA and each re-increment its 429 counter.
            err_payload = {
                "ok": True, "status": "unknown",
                "transport": "openwa", "error": r.text[:200],
            }
            _WA_STATUS_CACHE[sid] = (time.time(), err_payload)
            return _cors(jsonify(err_payload))
        s = r.json() or {}
        # OpenWA status strings: 'ready', 'qr_code', 'initializing',
        # 'disconnected', 'failed'. Translate to legacy 'connected' /
        # 'pending' / 'disconnected' so the UI's existing badges work.
        owa = s.get("status") or "unknown"
        mapped = {
            "ready":         "connected",
            "qr_code":       "pending",
            "initializing":  "pending",
            "disconnected":  "disconnected",
            "failed":        "disconnected",
        }.get(owa, owa)
        phone = s.get("phone")
        jid = f"{phone}@s.whatsapp.net" if phone else None
        payload = {
            "ok": True,
            "transport": "openwa",
            "session_id": sid,
            "status": mapped,
            "openwa_status": owa,
            "jid": jid,
            "phone": phone,
            "push_name": s.get("pushName"),
            "connected_at": s.get("connectedAt"),
            "last_seen_at": s.get("lastActive"),
            # OpenWA does QR / pairing-code via its own dashboard. Surface
            # a link so the operator clicks through to it from the admin.
            "dashboard_url": "http://localhost:2886",
        }
        _WA_STATUS_CACHE[sid] = (time.time(), payload)
        return _cors(jsonify(payload))
    except Exception as exc:
        return _cors(jsonify({
            "ok": False, "transport": "openwa", "error": str(exc),
        })), 200


def process_inbound_message(seller_id: str, from_jid: str, text: str,
                            sender_pn: str = "",
                            session_id: str = "") -> str:
    """Run one customer message through the full bot pipeline and return
    the reply text (or "" when the bot should stay silent).

    `session_id` is the OpenWA session UUID that delivered the message.
    When set, it lets us pick the seller's "default product for THIS
    number" (migration 0006 — products.whatsapp_session_ids). The legacy
    Baileys bridge path leaves it empty and the bot falls back to
    keyword detection (its original behavior).

    This is the shared core for BOTH transports:
      • Legacy Baileys bridge (POSTs to /webhook, sends the reply itself).
      • OpenWA gateway (POSTs to /openwa/webhook; brain calls OpenWA REST
        to deliver the reply).
    """
    if not (seller_id and from_jid and text):
        return ""

    # 1. Load the seller's config.
    seller = fetch_seller(seller_id)
    if not seller:
        log.warning("[process] unknown seller_id %s", seller_id)
        return ""
    if seller.get("status") != "active":
        log.info("[process] seller %s is %s — skipping reply", seller_id, seller.get("status"))
        return ""

    # Stamp the per-thread billing context so every LLM call inside this
    # turn (Agent 1 + Agent 2 + any future agents) lands in ai_usage_log
    # against the right org. conversation_id is filled in below once
    # we resolve / create the convo row.
    organization_id = (seller.get("organization_id")
                       or _resolve_organization_id_for_seller(seller_id))
    set_usage_context(seller_id=seller_id,
                      organization_id=organization_id,
                      conversation_id=None,
                      agent="agent2")

    # 1b. Free-trial gate. A self-serve signup gets instant access for a
    #     short window (TRIAL_DAYS / TRIAL_CONVERSATIONS_CAP). Once that
    #     window closes and there's no paid subscription, the bot goes
    #     silent until the seller upgrades. Fails OPEN — any error here
    #     lets the reply through so a live/paid seller is never muted.
    if not _trial_allows_reply(seller, organization_id):
        log.info("[process] seller %s free trial ended — bot silent until upgrade", seller_id)
        return ""

    # 2. Country detection. Priority:
    #    a. senderPn (bridge resolved the real phone number from a LID).
    #    b. The from-JID itself (only useful when it's not a LID).
    #    c. The seller's primary configured shipping country.
    country_code = (
        phone_to_country(sender_pn)
        or phone_to_country(from_jid)
        or (seller.get("country_codes") or [""])[0]
        or ""
    ).upper()

    # 3. Conversation row (creates on first contact).
    conversation = get_or_create_conversation(seller_id, from_jid, country_code)
    if not conversation:
        log.warning("[process] could not create/fetch conversation")
        return ""

    # Carry the conversation id into the billing context so per-call
    # usage rows pin to it. Lets the dashboard show "this conversation
    # cost X tokens" later.
    set_usage_context(seller_id=seller_id,
                      organization_id=organization_id,
                      conversation_id=conversation.get("id"),
                      agent="agent2")

    # 3b. Human takeover. If an operator flipped this conversation to
    # manual in the Conversations inbox (pending_order_fields.agent_paused),
    # persist the inbound so they see it in-thread but DON'T auto-reply —
    # a human is handling it now. They re-enable the bot with the Agent
    # toggle (which clears the flag).
    _pof = conversation.get("pending_order_fields") or {}
    if isinstance(_pof, dict) and _pof.get("agent_paused"):
        save_message(conversation["id"], "user", text)
        _supa_patch("customer_conversations", {"id": conversation["id"]},
                    {"last_message_at": datetime.now(timezone.utc).isoformat()})
        log.info("[process] conversation %s human-controlled — bot stays silent",
                 conversation["id"])
        return ""

    # 4. Resolve product + language (first message detects; subsequent use
    # the conversation's pinned values).
    product = None
    stored_language = conversation.get("language_code") or ""
    pc = None
    is_first_turn = not conversation.get("detected_product_id")
    # Track whether we should "fresh-start" everything (language, country,
    # pending order) — true on first turn AND on mid-conversation product
    # switches (because the customer just changed intent).
    fresh_start = is_first_turn
    if not is_first_turn:
        # Already detected on a previous turn — start with the pinned one.
        products = list_seller_products(seller_id)
        product = next((p for p in products if p["id"] == conversation["detected_product_id"]), None)
        # Mid-conversation product switching: if the customer's NEW message
        # explicitly names a DIFFERENT product, switch to it. This handles
        # "actually I want Medinail not BioRein" mid-chat. Customer intent
        # always wins over the pinned product.
        keyword_match = detect_product_in_message(text, products)
        if keyword_match and product and keyword_match["id"] != product["id"]:
            log.info("[product] mid-conversation switch: %s -> %s (customer named the new product)",
                     product.get("name"), keyword_match.get("name"))
            product = keyword_match
            # Repin the new product and clear the conversation's stale
            # language/country/pending so they re-resolve from the new
            # product's row. CRUCIALLY: also record history_reset_at so
            # load_conversation_history filters out the old product's
            # turns. Without this, the LLM keeps seeing "محمد wants 50
            # boxes at Agadir" in history and hallucinates those details
            # into the new product's confirmation summary.
            now_iso = datetime.now(timezone.utc).isoformat()
            fresh_pending = {"history_reset_at": now_iso}
            _supa_patch("customer_conversations", {"id": conversation["id"]}, {
                "detected_product_id": product["id"],
                "country_code": None,
                "language_code": None,
                "pending_order_fields": fresh_pending,
            })
            stored_language = ""
            conversation["country_code"] = None
            conversation["language_code"] = None
            conversation["pending_order_fields"] = fresh_pending
            fresh_start = True
        elif keyword_match and not product:
            # Pinned product was deleted/archived since last turn — adopt
            # whatever the customer just mentioned.
            log.info("[product] pinned product gone, adopting keyword match -> %s",
                     keyword_match.get("name"))
            product = keyword_match
            _supa_patch("customer_conversations", {"id": conversation["id"]},
                        {"detected_product_id": product["id"]})
            fresh_start = True
    else:
        products = list_seller_products(seller_id)
        # Smart routing (3-step ladder — see plan §2c):
        #   1. Keyword in the message ALWAYS wins. If the customer wrote
        #      a product name (or alias) the bot routes to it, regardless
        #      of which number they messaged. Customer intent > shop config.
        #   2. Session-default: if no keyword and the inbound number is
        #      pinned to a product via migration 0006's whatsapp_session_ids,
        #      use that product. Multiple pinned products on the same
        #      session → keyword-detect within that subset, else first.
        #   3. Neither: leave product = None and let build_system_prompt
        #      emit the "which product are you interested in?" branch.
        product = detect_product_in_message(text, products)
        if product:
            log.info("[product] resolved via keyword -> %s", product.get("name"))
        elif products and session_id:
            assigned = filter_products_assigned_to_session(products, session_id)
            if len(assigned) == 1:
                product = assigned[0]
                log.info("[product] resolved via session-default (%s) -> %s",
                         session_id, product.get("name"))
            elif len(assigned) > 1:
                # Several products share this number — try a keyword match
                # restricted to that subset; if still nothing, fall back to
                # the oldest pinned product (deterministic).
                product = detect_product_in_message(text, assigned) or assigned[0]
                log.info("[product] resolved via session-default subset (%s, %d candidates) -> %s",
                         session_id, len(assigned), product.get("name"))
        # Single-SKU shortcut: when the seller has exactly one active
        # product and the customer's first message didn't name anything,
        # there's no ambiguity — use that product directly instead of
        # asking "which product?". This preserves the friendly "salam"
        # → straight into the sales flow UX for single-product shops.
        if not product and products and len(products) == 1:
            product = products[0]
            log.info("[product] single-SKU shortcut -> %s", product.get("name"))

        # Lead-product fallback for CONTINUING conversations: when the
        # customer has talked to the bot before (the convo row already
        # has prior messages) but the current message has no keyword
        # AND no session-default applies, default to the FIRST active
        # product (typically the seller's hero product). Without this
        # the bot enters soft-greet mode every turn and the customer
        # sees "Salut, comment puis-je vous aider ?" repeated forever
        # — exactly the loop a real shop owner would resolve by just
        # pitching their main product.
        # IMPORTANT: only fires on continuing convos. The very first
        # turn still goes through the soft-greet so we don't pitch a
        # random product to someone who said "wrong number, sorry".
        if not product and products and len(products) > 1:
            try:
                prior_msgs = _supa_get("messages", {
                    "conversation_id": f"eq.{conversation['id']}",
                    "select": "id",
                    "limit": "1",
                })
                if prior_msgs:
                    product = products[0]
                    log.info("[product] lead-product fallback (continuing "
                             "convo, %d prior msgs known) -> %s",
                             len(prior_msgs), product.get("name"))
            except Exception as _exc:
                log.debug("[product] lead-fallback check failed: %s", _exc)
        # If we still have no product and the catalog has SOME products,
        # we DON'T silently default. Instead we ask the customer to name
        # which product they want — handled right below as an early-return
        # short-circuit so the rest of the pipeline (country snap, pricing,
        # prompt build, order push) doesn't have to be product-aware.

    # Empty catalog → bot has nothing to sell. Stay silent.
    if not product and not products:
        log.info("[process] empty catalog for seller %s — skipping", seller_id)
        return ""

    # No product resolved + catalog non-empty → reply with a SHORT, warm
    # greeting in the customer's language. We deliberately do NOT list
    # the seller's product names here (the seller asked: "don't dive
    # into product details until the customer asks"). The customer's
    # next message will name what they want and the keyword path picks
    # it up.
    if not product:
        # Language lock — STORED wins, sniffed bootstraps. Without this,
        # the soft-greet branch re-sniffed every turn and flipped the
        # reply language depending on what tokens were in this message
        # ('Salut' → fr, 'Labass' → ary, 'Kifdayr' → fr). The customer
        # saw the bot switching tongues every message — exactly the
        # bug the rest of process_inbound_message already fixes via
        # resolve_language() but the soft-greet path was bypassing it.
        sniffed = detect_message_language(text)
        lang = (stored_language
                or sniffed
                or seller.get("default_language") or "fr").lower()

        # Short, friendly opener — no product names mentioned. Stays
        # under 60 chars so it feels like a real shop owner replying
        # while reaching for their phone.
        if lang.startswith("ary"):
            ask_reply = "سلام 😊 كيفاش نقدر نعاونك؟"
        elif lang.startswith("ar"):
            ask_reply = "السلام عليكم 😊 كيف نقدر نعاونك؟"
        elif lang.startswith("fr"):
            ask_reply = "Salut 😊 Comment je peux vous aider ?"
        elif lang.startswith("he"):
            ask_reply = "היי 😊 איך אני יכול לעזור?"
        elif lang.startswith("es"):
            ask_reply = "¡Hola 😊! ¿En qué te puedo ayudar?"
        else:
            ask_reply = "Hi 😊 How can I help you?"
        log.info("[product] no auto-resolution for %s; soft greet in %s (sniffed=%s)",
                 from_jid, lang, sniffed or "—")
        try:
            save_message(conversation["id"], "user", text)
            save_message(conversation["id"], "assistant", ask_reply)
            # Pin the sniffed language so the conversation keeps speaking
            # it on subsequent no-product turns.
            patches = {"last_message_at": datetime.now(timezone.utc).isoformat()}
            if sniffed and (conversation.get("language_code") or "") != sniffed:
                patches["language_code"] = sniffed
            _supa_patch("customer_conversations", {"id": conversation["id"]}, patches)
        except Exception as exc:
            log.warning("[product] persist failed during soft-greet: %s", exc)
        return ask_reply

    # Country sanity-check: a @lid JID with no senderPn would have left
    # country_code unresolved (or wrong — libphonenumber happily parses
    # the LID's leading digits as Mauritius/Ecuador/etc.). Snap it to the
    # product's configured country so per-country pricing + language work.
    country_code = snap_country_to_product(country_code, product)

    # Pick the per-country row.
    pcs = product.get("product_countries") or []
    pc = next((x for x in pcs if (x.get("country_code") or "").upper() == country_code), None)
    if not pc and pcs:
        # Single-market product: snap_country_to_product already chose
        # this country, so the row should exist — guard anyway.
        pc = pcs[0]

    # Always re-resolve so older conversation rows with stale 'en' get
    # healed once the francophone fallback fires. CRITICALLY: sniff the
    # customer's actual message language so a Darija writer gets a
    # Darija reply even when the product is set up for a francophone
    # country. The customer's comfort beats the per-product default.
    sniffed = detect_message_language(text)
    language = resolve_language(
        (pc or {}).get("language_code") or "",
        stored_language,
        seller.get("default_language") or "",
        country_code,
        sniffed_language=sniffed,
    )

    # Persist corrections back to the conversation row. fresh_start covers
    # both first turn AND mid-conversation product switches — in both cases
    # we want the new product + new country/language pinned.
    patches: Dict = {"last_message_at": datetime.now(timezone.utc).isoformat()}
    if fresh_start:
        patches["detected_product_id"] = product["id"]
    if (conversation.get("country_code") or "") != country_code:
        patches["country_code"] = country_code
    if (conversation.get("language_code") or "") != language:
        patches["language_code"] = language
    if len(patches) > 1:  # more than just last_message_at
        _supa_patch("customer_conversations", {"id": conversation["id"]}, patches)
    stored_language = language

    # 5. Load running order draft + apply cheap, deterministic extractions
    # BEFORE building the prompt. This is what stops the bot from re-asking
    # "Combien de bouteilles?" after the customer already replied "1".
    pending = dict(conversation.get("pending_order_fields") or {})

    # Phone-from-WhatsApp logic:
    #   • @s.whatsapp.net JIDs ARE real phone numbers — use the digits.
    #   • @lid JIDs are opaque privacy identifiers. Baileys' senderPn
    #     sometimes echoes the LID digits back as a phone, but those are
    #     NOT dialable. Detect that case (sender_pn digits == LID digits)
    #     and treat the order as "phone unknown" so the seller is never
    #     handed a fake number to call.
    real_phone = ""
    if sender_pn:
        candidate_digits = re.sub(r"\D+", "", sender_pn)
        lid_digits = ""
        if jid_is_lid(from_jid):
            lid_digits = from_jid.split("@", 1)[0].split(":", 1)[0]
            lid_digits = re.sub(r"\D+", "", lid_digits)
        if candidate_digits and candidate_digits != lid_digits:
            real_phone = "+" + candidate_digits
    if not real_phone:
        real_phone = jid_to_phone(from_jid)  # "" for bare @lid JIDs

    # Last-resort phone resolver: for LIDs (and any non-resolvable JID),
    # ask OpenWA's contact endpoint. whatsapp-web.js can usually map the
    # LID back to the real E.164 number because WhatsApp's directory
    # knows that mapping for anyone who has ever messaged us. This is
    # what lets the Orders table + Sheets webhook show a callable phone
    # instead of empty.
    if not real_phone:
        sess_url, sess_key, sess_id = _resolve_openwa_config(seller)
        resolved = openwa_resolve_phone_for_jid(
            from_jid, session_id=sess_id, api_url=sess_url, api_key=sess_key,
        )
        if resolved:
            real_phone = resolved
            log.info("[openwa] resolved %s -> %s via contact lookup", from_jid, real_phone)

    if real_phone and not pending.get("phone"):
        pending["phone"] = real_phone

    # Early-lead capture: the moment a first message resolves to a
    # product AND we know the customer's phone, drop a partial row in
    # the seller's Sheet so they have a fallback contact if the customer
    # ghosts mid-conversation. Only fires once per conversation (first
    # turn) and only when we actually have a phone — empty-phone leads
    # are not actionable for follow-up. We also guard with a flag in
    # pending_order_fields so retries / re-runs don't dupe the lead.
    if fresh_start and real_phone and not pending.get("lead_pushed_at"):
        try:
            if push_lead_to_sheet(seller, product, conversation, from_jid, real_phone):
                pending["lead_pushed_at"] = datetime.now(timezone.utc).isoformat()
                # Persist the flag immediately so a parallel inbound on
                # the same conversation (rare but possible on retries)
                # doesn't fire a second lead push. merge_pending_order_fields
                # later in the turn only writes when extracted has new
                # keys, so we can't rely on it for the flag itself.
                _supa_patch("customer_conversations", {"id": conversation["id"]},
                            {"pending_order_fields": pending})
                log.info("[lead] captured for %s → %s (product %s)",
                         from_jid, real_phone, product.get("name"))
        except Exception as exc:
            log.warning("[lead] push failed: %s", exc)

    # Gallery send — opportunistically push the product's supplementary
    # images (gallery_urls) to the customer once per conversation, right
    # after the first turn so they SEE the product before any text. The
    # gallery is capped at 4 images so we don't spam, and runs in a
    # background thread so it doesn't slow the LLM reply.
    if fresh_start and not pending.get("gallery_sent_at"):
        gallery = (product or {}).get("gallery_urls") or []
        if isinstance(gallery, list) and gallery:
            sess_url, sess_key, sess_id = _resolve_openwa_config(seller)
            urls_to_send = [u for u in gallery[:4] if isinstance(u, str) and u.startswith(("http://", "https://"))]
            if urls_to_send:
                def _send_gallery():
                    import time
                    for u in urls_to_send:
                        try:
                            openwa_send_image(from_jid, u, caption="",
                                              session_id=sess_id,
                                              api_url=sess_url, api_key=sess_key)
                            # Stagger so WhatsApp doesn't queue them all in
                            # one batch and the customer sees them arrive
                            # like a real shop sending photos one by one.
                            time.sleep(1.5)
                        except Exception as exc:
                            log.warning("[gallery] send exception: %s", exc)
                threading.Thread(target=_send_gallery, daemon=True).start()
                pending["gallery_sent_at"] = datetime.now(timezone.utc).isoformat()
                _supa_patch("customer_conversations", {"id": conversation["id"]},
                            {"pending_order_fields": pending})
                log.info("[gallery] sending %d image(s) to %s for product %s",
                         len(urls_to_send), from_jid, product.get("name"))

    # Photos on demand — when the customer ASKS to see the product ("tsawr",
    # "صور", "des photos", "montre-moi", "wreeni"…), send its saved image(s):
    # the main image_url first, then any gallery images. Fires on ANY turn
    # (not just the first), with a short cooldown so a double-tap doesn't
    # double-send. Runs in a background thread so it never delays the text
    # reply; Agent 2 is told (photo_note) to acknowledge the photos naturally.
    photo_note = ""
    if product and _wants_photos(text):
        photo_urls: List[str] = []
        _main_img = (product or {}).get("image_url")
        if isinstance(_main_img, str) and _main_img.strip().startswith(("http://", "https://")):
            photo_urls.append(_main_img.strip())
        for _u in ((product or {}).get("gallery_urls") or []):
            if (isinstance(_u, str) and _u.strip().startswith(("http://", "https://"))
                    and _u.strip() not in photo_urls):
                photo_urls.append(_u.strip())
        photo_urls = photo_urls[:5]
        cooled = True
        _last_photo = pending.get("photos_sent_at")
        if _last_photo:
            try:
                cooled = (datetime.now(timezone.utc) - datetime.fromisoformat(
                    str(_last_photo).replace("Z", "+00:00"))).total_seconds() > 25
            except Exception:
                cooled = True
        if photo_urls and cooled:
            p_url, p_key, p_sid = _resolve_openwa_config(seller)

            def _send_photos(urls=photo_urls, su=p_url, sk=p_key, si=p_sid):
                import time
                for u in urls:
                    try:
                        openwa_send_image(from_jid, u, caption="",
                                          session_id=si, api_url=su, api_key=sk)
                        time.sleep(1.2)
                    except Exception as exc:
                        log.warning("[photos] send exception: %s", exc)

            threading.Thread(target=_send_photos, daemon=True).start()
            pending["photos_sent_at"] = datetime.now(timezone.utc).isoformat()
            try:
                _supa_patch("customer_conversations", {"id": conversation["id"]},
                            {"pending_order_fields": pending})
            except Exception:
                pass
            photo_note = (
                f"📸 You JUST sent the customer {len(photo_urls)} product photo(s) "
                f"they asked for. Acknowledge them warmly in ONE short line "
                f"(e.g. «Voici les photos ✨» / «ها هي الصور»), then continue the "
                f"sale. NEVER say you cannot send images."
            )
            log.info("[photos] sent %d image(s) to %s on request for product %s",
                     len(photo_urls), from_jid, (product or {}).get("name"))
        elif not photo_urls:
            photo_note = (
                "📸 The customer asked to see photos but this product has none "
                "saved. Apologize in ONE short line and offer to describe it "
                "instead. Do NOT promise to send images you don't have."
            )

    # Bare-number quantity fallback (LLM-independent).
    if not pending.get("quantity"):
        qty = extract_quantity_from_text(text)
        if qty:
            pending["quantity"] = qty

    history = load_conversation_history(
        conversation["id"],
        since_iso=pending.get("history_reset_at"),
    )

    # 6. Compose system prompt with the updated pending state baked in.
    product_kind = ((product or {}).get("kind") or "product").lower()
    # Seller-defined extraction schema for this service (migration 0012).
    # Computed once here and reused for the LLM output schema + the
    # ready-to-push gate below so all three agree on the field list.
    custom_fields = normalize_custom_fields(product) if product_kind == "service" else []
    sys_prompt = build_system_prompt(
        seller, product or {}, pc, language, country_code,
        pending=pending,
        history_len=len(history),
        phone_from_jid=real_phone,
        order_placed=(conversation.get("status") == "order_placed"),
        kind=product_kind,
        photo_note=photo_note,
    )
    messages = [{"role": "system", "content": sys_prompt}]
    for m in history[-AGENT2_HISTORY_MSGS:]:
        messages.append({"role": m["role"], "content": m["content"]})
    messages.append({"role": "user", "content": text})

    # Add the JSON-schema instruction so the LLM emits structured output.
    # NOTE: 'phone' is intentionally omitted — we extract it from the JID
    # (or sender_pn) so the bot never asks the customer.
    if product_kind == "service" and custom_fields:
        # Universal schema: one JSON key per seller-defined custom field.
        # merge_pending_order_fields already persists arbitrary keys, so
        # whatever the LLM returns here lands in pending_order_fields.
        _schema_lines = []
        for f in custom_fields:
            jtype = "<integer or null>" if f["type"] == "number" else "<string or null>"
            _schema_lines.append(
                f"      \"{f['key']}\": {jtype},  // {f['label']} "
                f"({'required' if f.get('required', True) else 'optional'})"
            )
        # Trim the trailing comma on the last line for clean example JSON.
        if _schema_lines:
            _schema_lines[-1] = _schema_lines[-1].replace(",  //", "   //", 1)
        schema_fields = "\n".join(_schema_lines)
        _has_date = any(f["type"] == "date" for f in custom_fields)
        extraction_examples = (
            "  • Extract ONLY the keys listed above — they are the exact "
            "    fields this service needs. Leave a key null until the "
            "    customer actually provides it.\n"
            "  • Services are 1 booking — NEVER invent a quantity field.\n"
            + ("  • For date/time fields, store EXACTLY what the customer "
               "    wrote ('vendredi', 'غدا في الصباح', '15 juin'). Don't "
               "    translate or normalize to YYYY-MM-DD — a human reads it.\n"
               if _has_date else "")
        )
    elif product_kind == "service":
        schema_fields = (
            "      \"name\":         <string or null>,  // customer's first name only\n"
            "      \"service_date\": <string or null>,  // when they want it (free text — accept 'demain', 'vendredi', 'غدا', '15 juin', etc.)\n"
            "      \"city\":         <string or null>,  // city or zone\n"
            "      \"address\":      <string or null>,  // exact address / pickup point\n"
            "      \"notes\":        <string or null>   // free-form specifics (rental: model + days; service: what to do)"
        )
        extraction_examples = (
            "  • For services NEVER set quantity. \"3 jours\" / \"3 days\" "
            "    belongs in NOTES, NOT quantity.\n"
            "  • For service_date: store EXACTLY what the customer wrote. "
            "    \"vendredi\" stays as \"vendredi\". \"غدا في الصباح\" "
            "    stays as \"غدا في الصباح\". Don't translate, don't "
            "    normalize to YYYY-MM-DD — a human reads the sheet.\n"
        )
    else:
        schema_fields = (
            "      \"name\":     <string or null>,  // customer's first name only\n"
            "      \"address\":  <string or null>,  // street / building / neighborhood\n"
            "      \"city\":     <string or null>,  // city or town\n"
            "      \"quantity\": <integer or null>  // 1-50 only"
        )
        extraction_examples = ""
    messages[0]["content"] += (
        "\n\n╔═══ OUTPUT FORMAT — STRICT JSON ═══╗\n"
        "Return ONLY a JSON object (no markdown fences, no preamble) with "
        "EXACTLY these keys:\n"
        "  {\n"
        "    \"reply\": \"<your reply text — what the customer will see>\",\n"
        "    \"intent\": \"asking_info\" | \"haggling\" | \"ready_to_order\" | \"cancel\",\n"
        "    \"extracted_order_fields\": {\n"
        f"{schema_fields}\n"
        "    }\n"
        "  }\n\n"
        + extraction_examples +
        "EXTRACTION RULES (very important — the previous turns prove the "
        "bot was failing here):\n"
        "  • Read the customer's LAST message AND the chat history. If they "
        "    just said e.g. \"smiti Mohamed\" / \"je m'appelle Karim\" / "
        "    \"ana Sofia\" / \"my name is Yassine\" — set name to JUST the "
        "    first name (e.g. \"Mohamed\", \"Karim\", \"Sofia\", \"Yassine\"). "
        "    Strip the \"smiti\"/\"je m'appelle\"/\"ana\"/\"my name is\" part.\n"
        "  • If the customer said e.g. \"ana f Casablanca\" / \"je suis à "
        "    Rabat\" / \"f Tanger ana\" — set city to just \"Casablanca\" / "
        "    \"Rabat\" / \"Tanger\".\n"
        "  • If they gave an address (e.g. \"hay mohammadi rue 12\"), set "
        "    address to the full string.\n"
        "  • If they said a number that fits the quantity context (1-50), "
        "    set quantity.\n"
        "  • Once a field is set in the COLLECTED block above, ALWAYS echo "
        "    it back unchanged in your JSON so it's never lost across turns "
        "    — unless the customer explicitly corrects themselves.\n"
        "  • Use null (not empty string) when a field is genuinely unknown.\n"
        "Never wrap the JSON in markdown fences. Never add commentary "
        "before or after the JSON. Just the object."
    )

    # 7. Call the LLM.
    # Resolution order:
    #   1. admin /funnel/admin/settings → system_settings.json (live, no
    #      restart needed — operator switches model globally there).
    #   2. seller's openrouter_model column (per-tenant override).
    #   3. .env DEFAULT_MODEL.
    # Previously seller.openrouter_model won, but the schema default for
    # that column is 'openai/gpt-4o-mini' so every newly-created seller
    # silently pinned itself to mini and ignored what the admin chose in
    # the settings JSON. System setting wins now.
    system_model = get_openrouter_model()
    seller_model = (seller.get("openrouter_model") or "").strip()
    model = system_model or seller_model or DEFAULT_MODEL

    # ─── 2-Agent SaaS pipeline ──────────────────────────────────────────
    #   Agent 1 (gpt-4o-mini by default) — analyzes message, returns
    #             JSON with intent / language / vibe / lead_priority /
    #             normalized fields / address_incomplete. Triple-tier
    #             fallback INSIDE agents.run_agent1, so it always
    #             returns something.
    #   Agent 2 (this seller's premium model) — generates the WhatsApp
    #             reply, using Agent 1's structured output. When
    #             Agent 1 says all fields are collected, we inject a
    #             vibe-tailored CLOSING block into Agent 2's system
    #             prompt and Agent 2 produces a unique anti-repetition
    #             confirmation message.
    from agents import (
        run_agent1 as _agents_run_agent1,
        build_closing_block as _agents_build_closing_block,
    )

    agent_state, agent1_fields = _agents_run_agent1(
        seller_id=seller["id"],
        conversation_id=conversation["id"],
        from_jid=from_jid,
        phone=real_phone,
        raw_text=text,
        pending_fields=pending,
        stored_language=stored_language,
        detect_language_fn=detect_message_language,
        llm_raw_call_fn=llm_raw_call,
        history=history,
        kind=product_kind,
    )

    # Merge Agent 1's validated fields into the running pending state
    # BEFORE Agent 2 builds its prompt — so Agent 2 sees the most
    # up-to-date "COLLECTED SO FAR" and never asks for what we just
    # captured this turn.
    if agent1_fields:
        for k, v in agent1_fields.items():
            if v not in (None, ""):
                pending[k] = v
        agent_state.collected_fields = pending

    # Stamp Agent 1's per-turn metadata onto pending so it persists into
    # customer_conversations and survives all the way to the seller's
    # Excel export — even if this turn isn't the closing turn. The
    # seller can sort by lead_priority across the whole funnel.
    pending["lead_priority"] = agent_state.lead_priority
    notes_summary = agent_state.notes_summary()
    if notes_summary:
        pending["bot_internal_notes"] = notes_summary
    if agent_state.intent_type and agent_state.intent_type != "product_purchase":
        pending["intent_type"] = agent_state.intent_type
    if agent_state.address_incomplete:
        pending["address_incomplete"] = True
    elif "address_incomplete" in pending and not agent_state.address_incomplete:
        # Customer just sent a complete address — clear the prior flag.
        pending.pop("address_incomplete", None)

    # If Agent 1 says all required fields are now in, prepare the
    # vibe-tailored closing block. Empty string when not in closing
    # mode — build_system_prompt just appends nothing in that case.
    closing_block = ""
    is_closing_turn = agent_state.has_required(product_kind)
    if is_closing_turn:
        price_line = ""
        try:
            p_val = (pc or {}).get("price")
            cur = (pc or {}).get("currency") or ""
            if p_val and cur:
                price_line = f"{p_val} {cur}"
        except Exception:
            pass
        closing_block = _agents_build_closing_block(
            agent_state, product_kind,
            (product or {}).get("name") or "",
            price_line,
        )

    # Agent 1 may have enriched `pending` since the original prompt was
    # built — and we want the CLOSING block injected when applicable.
    # Simplest correct path: append the closing block to the existing
    # system prompt (which already carries the original strict-JSON
    # OUTPUT FORMAT schema from above). Avoids the double-schema bug
    # where two competing output specs made Agent 2 leak schema labels
    # into the customer-facing reply.
    if closing_block:
        messages[0]["content"] += "\n\n" + closing_block

    # Agent 2 — the public-face conversational call. Uses llm_reply's
    # built-in triple-tier (response_format → plain-text retry → empty
    # retry), so empties here are extremely rare.
    #
    # AI cascade: spend the premium model ONLY where it converts — the
    # closing turn and clearly hot leads. Routine turns (greet, FAQ, field
    # collection) use the cheap model. ~4-5× cheaper per conversation, which
    # is what makes the unit economics profitable at $17–$34. If the
    # configured model is already the cheap one, this is a no-op.
    agent2_model = model
    if AI_CASCADE and model != CASCADE_CHEAP_MODEL:
        _lp = str(getattr(agent_state, "lead_priority", "") or "").lower()
        _hot = _lp in ("high", "hot", "urgent", "very_high")
        if not (is_closing_turn or _hot):
            agent2_model = CASCADE_CHEAP_MODEL
    llm_out = llm_reply(messages, agent2_model)
    reply_text = (llm_out.get("reply") or "").strip()
    intent = llm_out.get("intent") or "asking_info"
    extracted = llm_out.get("extracted_order_fields") or {}
    # On a closing turn, force intent so the order push fires even if
    # Agent 2 forgot to set ready_to_order in its JSON.
    if is_closing_turn and intent == "asking_info":
        intent = "ready_to_order"

    # NEVER GO SILENT. If the LLM returned an empty reply (content
    # moderation, model refusal on abusive customer messages, JSON
    # parse failure, etc.), substitute a graceful neutral acknowledgement
    # in the conversation's language so the customer doesn't feel
    # ghosted. We rotate across 4 variants per language and avoid the
    # one used on the immediately previous turn so customers don't see
    # the SAME fallback text twice in a row.
    if not reply_text:
        log.warning("[llm] empty reply for %s — using graceful fallback (intent=%s)",
                    from_jid, intent)
        fallback_pool = {
            "ary": [
                "واخا 🙏 عاود لي شنو بغيتي بالضبط؟",
                "ما فهمتش مزيان، تقدر تعاود؟",
                "صافي، قول لي شنو هو المنتج لي بغيتي؟",
                "أوكي، شنو هي الكمية لي بغيتي؟",
            ],
            "ar": [
                "حسنًا 🙏 من فضلك أعد ما تريد",
                "لم أفهم جيدًا، أعد من فضلك",
                "تمام، ما هو المنتج المطلوب؟",
                "أوكي، كم الكمية التي تريد؟",
            ],
            "fr": [
                "D'accord, dites-moi ce que vous cherchez exactement",
                "Pardon, je n'ai pas bien saisi, vous pouvez répéter ?",
                "Ok, quel produit vous intéresse ?",
                "Très bien, combien d'unités vous voulez ?",
            ],
            "en": [
                "Got it, what exactly are you looking for?",
                "Sorry, I missed that — could you repeat?",
                "Ok, which product would you like?",
                "Right, how many would you like?",
            ],
            "he": ["סבבה 🙏 תוכל לחזור על מה שאתה רוצה?",
                   "סליחה, לא הבנתי, תוכל לחזור?",
                   "אוקיי, איזה מוצר מעניין אותך?",
                   "מה הכמות שאתה רוצה?"],
            "es": ["Entendido, ¿qué buscas exactamente?",
                   "Perdón, no entendí bien, ¿puedes repetir?",
                   "Vale, ¿qué producto te interesa?",
                   "¿Cuántas unidades quieres?"],
        }
        pool = fallback_pool.get(language[:3]) or fallback_pool.get(language[:2]) or fallback_pool["en"]
        # Pull the previous assistant turn UNFILTERED by history_reset_at
        # so right after a product switch (when `history` is empty under
        # since_iso) we still know what we sent last and can avoid
        # repeating it. Customer-visible repeats look like the bot is
        # broken even if the rest of the logic is fine.
        recent_assistant = _supa_get("messages", {
            "conversation_id": f"eq.{conversation['id']}",
            "role": "eq.assistant",
            "select": "content",
            "order": "created_at.desc",
            "limit": "1",
        })
        last_assistant = (recent_assistant[0]["content"]
                          if recent_assistant else "")
        choices = [c for c in pool if c != last_assistant] or pool
        import random as _r
        reply_text = _r.choice(choices)

    # 8. Save user + assistant turns.
    save_message(conversation["id"], "user", text)
    if reply_text:
        save_message(conversation["id"], "assistant", reply_text)

    # 9. Merge the LLM's extracted fields into our running pending and
    # persist (the bare-number quantity was already merged above).
    # Apply the same deterministic city normalization Agent 1 uses so
    # Agent 2's "ana f casa" → "casa" gets canonicalized to "Casablanca"
    # before it overwrites the value Agent 1 just normalized.
    if extracted:
        try:
            from agents import normalize_city as _norm_city
            if extracted.get("city"):
                canon, _matched = _norm_city(str(extracted["city"]))
                if canon:
                    extracted["city"] = canon
        except Exception as exc:
            log.warning("[agents] city normalize on Agent2 extract failed: %s", exc)
    pending = merge_pending_order_fields(conversation["id"], pending, extracted)

    # 10. If the customer just confirmed and we have everything, fire the
    # order push (insert into `orders` + POST to the Sheets webhook).
    # GUARD: once a conversation is in 'order_placed', every subsequent
    # "oui / merci / d'accord" still parses as intent=ready_to_order and
    # would create a duplicate order row. Only push the FIRST time.
    # Idempotency: build a signature from name+address+city+qty+product.
    # If this conversation already pushed an order with the EXACT same
    # signature, skip the push. The LLM tends to re-extract identical
    # fields from chat history when the customer follows up with
    # "wakha / merci / oui confirmé", which used to create duplicate
    # order rows. A genuinely different second order (new quantity,
    # new address) produces a new signature → goes through.
    current_sig = _order_signature(pending, (product or {}).get("id"),
                                   custom_fields=custom_fields)
    last_sig = pending.get("last_order_sig") or ""
    duplicate = bool(current_sig) and (current_sig == last_sig)
    if intent == "ready_to_order" and order_ready_to_push(pending, kind=product_kind, custom_fields=custom_fields) and not duplicate:
        # 2-Agent finishing path. The closing-mode reply was already
        # generated by Agent 2 (via the agent1_closing_block injected
        # into the system prompt above). Here we just stamp Agent 1's
        # judgement onto pending so it survives into the orders row +
        # the seller's Excel export.
        pending["lead_priority"] = agent_state.lead_priority
        notes_summary = agent_state.notes_summary()
        if notes_summary:
            pending["bot_internal_notes"] = notes_summary
        if agent_state.intent_type and agent_state.intent_type != "product_purchase":
            pending["intent_type"] = agent_state.intent_type
        if agent_state.address_incomplete:
            pending["address_incomplete"] = True
        # Persist BEFORE the push so the row in customer_conversations
        # has lead_priority + notes even if build_and_push_order races.
        try:
            _supa_patch("customer_conversations", {"id": conversation["id"]},
                        {"pending_order_fields": pending})
        except Exception as exc:
            log.warning("[agents] persist pending pre-push failed: %s", exc)

        build_and_push_order(seller, product, pc, conversation,
                             from_jid, country_code, pending)
    elif intent == "ready_to_order" and duplicate:
        log.info("[order] conversation %s — duplicate ready_to_order with "
                 "matching signature, skipping push", conversation["id"])

    return reply_text


# ── HTTP transport: legacy Baileys bridge ────────────────────────────────
@app.route("/webhook", methods=["POST", "OPTIONS"])
def webhook():
    """Legacy entry point — the Baileys bridge POSTs
    { seller_id, from, text, sender_pn? } and expects { reply } back so it
    can send the message itself with anti-ban timing. Kept for backward
    compatibility; new traffic flows through /openwa/webhook."""
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    body = request.get_json(silent=True) or {}
    seller_id = (body.get("seller_id") or "").strip()
    from_jid = (body.get("from") or "").strip()
    text = (body.get("text") or "").strip()
    sender_pn = (body.get("sender_pn") or "").strip()
    if not (seller_id and from_jid and text):
        return _cors(jsonify({"error": "seller_id, from, text all required"})), 400
    reply = process_inbound_message(seller_id, from_jid, text, sender_pn)
    return _cors(jsonify({"reply": reply}))


# In-flight webhook dedupe — OpenWA retries timed-out webhooks up to
# WEBHOOK_MAX_RETRIES times. Without this guard we'd process the same
# customer message 3-4 times, sending duplicate replies and burning LLM
# tokens. Idempotency keys arrive on every payload so we just remember
# the last few and short-circuit retries. Bounded LRU-ish via the size
# check — never grows past ~2000 entries.
_OPENWA_SEEN_KEYS: "Dict[str, float]" = {}
_OPENWA_SEEN_KEYS_LOCK = threading.Lock()


def _openwa_already_seen(idem_key: str) -> bool:
    if not idem_key:
        return False
    now = time.time()
    with _OPENWA_SEEN_KEYS_LOCK:
        if idem_key in _OPENWA_SEEN_KEYS:
            return True
        _OPENWA_SEEN_KEYS[idem_key] = now
        # Trim entries older than 1 hour OR when map grows large.
        if len(_OPENWA_SEEN_KEYS) > 2000:
            cutoff = now - 3600
            for k in list(_OPENWA_SEEN_KEYS.keys()):
                if _OPENWA_SEEN_KEYS[k] < cutoff:
                    del _OPENWA_SEEN_KEYS[k]
    return False


def _process_openwa_async(seller_id: str, from_jid: str, text: str,
                          sender_pn: str, session_id: str,
                          bot_pn: str = "") -> None:
    """Background worker: actually does the LLM call + send.

    Pulled out of the request handler so the HTTP response goes back to
    OpenWA in <100ms. OpenWA's webhook timeout (10s default) would
    otherwise abort the connection before brain's ~5-10s LLM call
    finishes, triggering retries that produce duplicate replies.

    The seller's row carries its own OpenWA URL + API key + session ID
    (admin Settings → WhatsApp gateway), so multi-tenant installs can
    route different sellers to different OpenWA instances. Falls back
    to the env-var defaults when those columns are empty.
    """
    try:
        # Resolve the seller AFTER the ACK now (moved out of the webhook
        # handler so the HTTP response goes back in <100ms). If we can't
        # map the session_id to a seller, log and drop — there's no one
        # to bill the message to and we'd just create orphan rows.
        if not seller_id:
            seller_id = openwa_resolve_seller_id(session_id, bot_pn) or ""
            if not seller_id:
                log.warning("[openwa-async] no seller mapped for session %s "
                            "(bot_pn=%s) — dropping inbound from %s",
                            session_id, bot_pn or "?", from_jid)
                return

        reply = process_inbound_message(seller_id, from_jid, text, sender_pn,
                                        session_id=session_id)
        if reply:
            # Resolve the seller's OpenWA credentials BEFORE sending. The
            # session_id from the webhook tells us which session received
            # the message, but the API key / URL come from the seller row.
            seller = fetch_seller(seller_id) or {}
            api_url, api_key, _stored_sid = _resolve_openwa_config(seller)
            # If the seller row pins a different session_id than the
            # webhook came on, trust the webhook (the bot might be paired
            # to a backup session not yet recorded in Settings).
            openwa_send_text(
                from_jid, reply,
                session_id=session_id,
                api_url=api_url,
                api_key=api_key,
            )
    except Exception as exc:
        log.exception("[openwa-async] processing failed for %s: %s", from_jid, exc)


# ── HTTP transport: OpenWA gateway ───────────────────────────────────────
@app.route("/openwa/webhook", methods=["POST", "OPTIONS"])
def openwa_webhook():
    """OpenWA POSTs us a payload of the shape:
        {
          "event": "message.received",
          "sessionId": "<uuid>",
          "timestamp": "ISO-8601",
          "idempotencyKey": "...",
          "deliveryId": "...",
          "data": {
            "from": "212XXXXXXXXX@c.us",
            "to":   "212YYYYYYYYY@c.us",
            "body": "salut",
            "type": "chat",
            "fromMe": false,
            "isGroup": false,
            ...
          }
        }
    We ACK in <100ms and offload LLM + send to a background thread so
    OpenWA's 10s webhook timeout never fires on us."""
    if request.method == "OPTIONS":
        return _cors(jsonify({}))

    body = request.get_json(silent=True) or {}
    event = (body.get("event") or "").strip()
    session_id = (body.get("sessionId") or "").strip()
    data = body.get("data") or {}

    # Acknowledge anything we don't care about, fast.
    if event != "message.received":
        return _cors(jsonify({"ok": True, "ignored": event})), 200

    if data.get("fromMe") or data.get("isGroup"):
        return _cors(jsonify({"ok": True, "ignored": "fromMe-or-group"})), 200

    from_jid = (data.get("from") or "").strip()
    text = (data.get("body") or "").strip()
    if not (from_jid and text):
        return _cors(jsonify({"ok": True, "ignored": "missing-from-or-body"})), 200

    # WhatsApp Status / Broadcast / Newsletter pings arrive as inbound
    # events from synthetic JIDs we must NEVER treat as customer chats
    # (we can't send a reply to them and they don't represent a real
    # contact). Drop them silently — they used to trigger a lead row
    # in the seller's sheet with "Phone = +status".
    bad_suffixes = ("@broadcast", "@newsletter", "@status_v3")
    bad_users = {"status", "0"}
    user_part = from_jid.split("@", 1)[0].lower()
    if any(from_jid.lower().endswith(s) for s in bad_suffixes) or user_part in bad_users:
        return _cors(jsonify({"ok": True, "ignored": "broadcast-or-status"})), 200

    # Build a dedupe key from the message-id WhatsApp gave us. OpenWA's
    # own `idempotencyKey` is buggy — its toStr() utility returns the
    # literal string "unknown" as a fallback, but then `||` treats that
    # truthy value as a real ID, so EVERY message ends up with
    # idempotencyKey="msg_unknown". Using that key dropped every
    # follow-up message in a conversation. Trust data.id instead.
    msg_id = (data.get("id") or data.get("messageId") or "").strip()
    from_digits = re.sub(r"\D+", "", from_jid.split("@", 1)[0]) if from_jid else ""
    if msg_id:
        idem_key = f"msg:{msg_id}"
    else:
        # Last-resort key when there's no message-id at all: combine the
        # sender, the body (first 80 chars), and the rounded timestamp.
        # This still dedupes within-second retries without collapsing
        # legitimate distinct messages.
        ts = data.get("timestamp") or 0
        idem_key = f"hb:{from_digits}:{hash(text[:80])}:{int(ts)}"

    if _openwa_already_seen(idem_key):
        log.info("[openwa] duplicate delivery %s — short-circuiting", idem_key[:24])
        return _cors(jsonify({"ok": True, "ignored": "duplicate-delivery"})), 200

    sender_pn = re.sub(r"\D+", "", from_jid.split("@", 1)[0]) if from_jid else ""

    # The bot's OWN number lives in `to` — it's the stable key the async
    # resolver uses to self-heal the seller mapping when OpenWA's session
    # UUID has churned (re-pair / recreate mints a new UUID).
    to_jid = (data.get("to") or "").strip()
    bot_pn = re.sub(r"\D+", "", to_jid.split("@", 1)[0]) if to_jid else ""

    # ACK NOW — push EVERYTHING (seller-id resolution included) into the
    # background thread. Previously we resolved the seller_id pre-ACK,
    # which cost 2-3 Supabase round-trips (~500-2500ms depending on
    # network) and could blow past OpenWA's 10s webhook timeout on a
    # slow link. The seller lookup is identical whether we do it before
    # or after the ACK, so doing it after means OpenWA is never kept
    # waiting and the customer-visible reply latency drops by 1-2s.
    threading.Thread(
        target=_process_openwa_async,
        args=("", from_jid, text, sender_pn, session_id),
        daemon=True,
    ).start()

    return _cors(jsonify({"ok": True, "queued": True})), 200


# ─────────────────────────────────────────────────────────────────────────
# Funnel API — consumed by the OpenWA dashboard's new "Bot Funnel" pages
# so the operator can manage products, view orders, and tune bot settings
# from the same dashboard that owns the WhatsApp session. Each endpoint
# is unauthenticated but localhost-only (the dashboard proxies through
# Vite's dev server to /api/funnel/...; in prod the dashboard is served
# from the same origin as brain via a reverse proxy).
# ─────────────────────────────────────────────────────────────────────────

def _funnel_seller_id() -> Optional[str]:
    """Resolve which seller this funnel request belongs to.

    Multi-tenant now (since signup landed) — resolution order:
      1. X-Seller-Id header (dashboard sends this from sessionStorage).
      2. ?seller_id= query param (manual / debug overrides).
      3. Single-seller fallback for legacy / first-install installs.
    """
    sid = (request.headers.get("X-Seller-Id") or request.args.get("seller_id") or "").strip()
    if sid:
        return sid
    # Legacy single-seller fallback — only when there's exactly one seller
    # in the DB. Anything beyond that and we require an explicit id.
    sellers = _supa_get("sellers", {"select": "id", "limit": "2"})
    if len(sellers) == 1:
        return sellers[0].get("id")
    return None


def _funnel_only_localhost():
    """Restrict funnel mutations to localhost — the dashboard runs there in
    dev (Vite proxy) and behind the same reverse proxy in prod.

    Cloud: the dashboard proxies to the brain over the private network, so the
    brain sees the proxy's IP (not localhost). Set FUNNEL_ALLOW_REMOTE=1 to
    allow it — SAFE ONLY when the brain is reachable PRIVATELY (no public
    Railway domain): the only thing that can reach it is the dashboard proxy.
    Never enable this on a publicly-exposed brain (X-Seller-Id is client-set)."""
    if os.environ.get("FUNNEL_ALLOW_REMOTE", "").strip().lower() in ("1", "true", "yes", "on"):
        return True
    remote = (request.remote_addr or "").lower()
    return remote in ("127.0.0.1", "::1", "localhost") or remote.endswith("::ffff:127.0.0.1")


# ────────────────────────────────────────────────────────────────────────
# AUTH ENDPOINTS — login / signup / admin approval
#
# Approval model (uses existing sellers.status check constraint values):
#   - 'paused'    → awaiting platform admin approval (new signups)
#   - 'active'    → approved, can log in normally
#   - 'disabled'  → rejected / suspended (cannot log in)
#
# Admin identity = a row in app_users with role='admin' and seller_id=NULL.
# Admin auth on the admin endpoints uses the Supabase access_token returned
# by login as a bearer token (verified via Supabase's /auth/v1/user).
# ────────────────────────────────────────────────────────────────────────

def _supa_auth_user_from_token(access_token: str) -> Optional[Dict]:
    """Resolve a Supabase access_token to its auth.users row.
    Returns None if the token is invalid or the call fails."""
    anon = os.environ.get("SUPABASE_ANON_KEY", "")
    if not (SUPABASE_URL and anon and access_token):
        return None
    try:
        r = httpx.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={
                "apikey": anon,
                "Authorization": f"Bearer {access_token}",
            },
            timeout=10,
            verify=_SUPA_VERIFY,
        )
        if r.status_code == 200:
            return r.json() or None
    except Exception as exc:
        log.warning("[auth] token verify failed: %s", exc)
    return None


def _require_admin() -> Optional[Dict]:
    """For admin-only endpoints. Pulls the Bearer token off the request,
    verifies it with Supabase, then checks app_users.role='admin'. Returns
    the auth user dict on success, None if not authorised."""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return None
    token = auth_header[7:].strip()
    user = _supa_auth_user_from_token(token)
    if not user:
        return None
    user_id = user.get("id")
    if not user_id:
        return None
    rows = _supa_get("app_users", {
        "id": f"eq.{user_id}",
        "select": "role",
        "limit": "1",
    }) or []
    if not rows or rows[0].get("role") != "admin":
        return None
    return user


@app.route("/funnel/auth/login", methods=["POST", "OPTIONS"])
def funnel_auth_login():
    """Email/password login proxied through Supabase Auth.

    Three valid outcomes depending on the user's role + seller status:
      - admin            → {role: 'admin', access_token}  (no openwa keys)
      - active seller    → {role: 'seller', openwa_*, seller_id, ...}
      - paused seller    → 403 {error: 'pending_approval'}
      - disabled seller  → 403 {error: 'account_suspended'}
    """
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    password = (body.get("password") or "")
    if not (email and password):
        return _cors(jsonify({"error": "email and password required"})), 400

    anon = os.environ.get("SUPABASE_ANON_KEY", "")
    if not (SUPABASE_URL and anon):
        return _cors(jsonify({"error": "supabase not configured"})), 500

    try:
        r = httpx.post(
            f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
            headers={
                "apikey": anon,
                "Content-Type": "application/json",
            },
            json={"email": email, "password": password},
            timeout=15,
            verify=_SUPA_VERIFY,
        )
    except Exception as exc:
        log.warning("[auth] supabase request failed: %s", exc)
        return _cors(jsonify({"error": "auth unreachable"})), 502

    if r.status_code != 200:
        msg = "invalid email or password"
        try:
            j = r.json()
            msg = j.get("error_description") or j.get("msg") or msg
        except Exception:
            pass
        return _cors(jsonify({"error": msg})), 401

    auth = r.json() or {}
    user = auth.get("user") or {}
    user_id = user.get("id")
    access_token = auth.get("access_token") or ""
    if not user_id:
        return _cors(jsonify({"error": "no user id in auth response"})), 500

    app_user_rows = _supa_get("app_users", {
        "id": f"eq.{user_id}",
        "select": "seller_id,role",
        "limit": "1",
    }) or []
    if not app_user_rows:
        return _cors(jsonify({"error": "no profile for this account"})), 403
    seller_id = app_user_rows[0].get("seller_id")
    role = app_user_rows[0].get("role") or "seller"

    # Admin: no seller, but hand back the gateway's master key so the
    # existing dashboard pages (Sessions, Webhooks, Plugins, etc.) work
    # for admin too. Plus the Supabase token for Bearer auth on the
    # admin-only /funnel/admin/* endpoints.
    if role == "admin":
        return _cors(jsonify({
            "ok": True,
            "role": "admin",
            "email": email,
            "access_token": access_token,
            "openwa_api_url": OPENWA_API_URL or "",
            "openwa_api_key": OPENWA_API_KEY or "",
            "openwa_session_id": OPENWA_SESSION_ID or "",
        })), 200

    # Seller path — check approval status.
    seller = fetch_seller(seller_id) or {}
    seller_status = (seller.get("status") or "active").lower()

    if seller_status == "paused":
        return _cors(jsonify({
            "error": "pending_approval",
            "message": "Your account is awaiting admin approval.",
            "business_name": seller.get("business_name"),
        })), 403

    if seller_status == "disabled":
        return _cors(jsonify({
            "error": "account_suspended",
            "message": "Your account has been suspended. Contact support.",
        })), 403

    openwa_api_key = seller.get("openwa_api_key") or OPENWA_API_KEY or ""
    openwa_api_url = seller.get("openwa_api_url") or OPENWA_API_URL or ""
    openwa_session_id = seller.get("openwa_session_id") or OPENWA_SESSION_ID or ""

    return _cors(jsonify({
        "ok": True,
        "role": role,
        "seller_id": seller_id,
        "business_name": seller.get("business_name"),
        "email": email,
        "access_token": access_token,
        "openwa_api_key": openwa_api_key,
        "openwa_api_url": openwa_api_url,
        "openwa_session_id": openwa_session_id,
    })), 200


@app.route("/funnel/auth/signup", methods=["POST", "OPTIONS"])
def funnel_auth_signup():
    """Create a new seller account — instant free trial by default.

    Flow:
      1. Create the Supabase auth user via the admin API (service_role,
         email_confirm=true so the seller can immediately log in).
      2. Insert the seller row. When TRIAL_AUTO_ACTIVATE is on (default)
         the row starts status='active' + is_trial=true with a trial
         window (TRIAL_DAYS / TRIAL_CONVERSATIONS_CAP) so the seller can
         use the bot right away; otherwise it starts 'paused' and waits
         for an admin to approve.
      3. Insert the app_users row (role='seller', linked to that seller).

    Returns either a "trial_active" payload (dashboard auto-logs the
    seller in) or the legacy "pending_approval" payload (approval-gated
    mode), depending on TRIAL_AUTO_ACTIVATE.
    """
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    password = (body.get("password") or "")
    business_name = (body.get("business_name") or "").strip()
    country_codes = body.get("country_codes") or []
    default_language = (body.get("default_language") or "en").lower()

    if not (email and password and business_name):
        return _cors(jsonify({"error": "email, password and business_name required"})), 400
    if len(password) < 8:
        return _cors(jsonify({"error": "password must be at least 8 characters"})), 400
    if not isinstance(country_codes, list):
        country_codes = []
    country_codes = [c.strip().upper() for c in country_codes if isinstance(c, str) and c.strip()]

    if not (SUPABASE_URL and SUPABASE_SERVICE_KEY):
        return _cors(jsonify({"error": "supabase not configured"})), 500

    # 1. Create auth user via admin API.
    try:
        r = httpx.post(
            f"{SUPABASE_URL}/auth/v1/admin/users",
            headers={
                "apikey": SUPABASE_SERVICE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "email": email,
                "password": password,
                "email_confirm": True,
                "user_metadata": {"business_name": business_name, "role": "seller"},
            },
            timeout=15,
            verify=_SUPA_VERIFY,
        )
    except Exception as exc:
        log.warning("[signup] auth create failed: %s", exc)
        return _cors(jsonify({"error": "auth unreachable"})), 502

    if r.status_code not in (200, 201):
        msg = "could not create account"
        try:
            j = r.json()
            msg = j.get("msg") or j.get("error_description") or j.get("error") or msg
        except Exception:
            pass
        if "already" in (msg or "").lower():
            return _cors(jsonify({"error": "account_exists", "message": "An account with that email already exists."})), 409
        return _cors(jsonify({"error": msg})), 400

    auth_user = r.json() or {}
    user_id = auth_user.get("id")
    if not user_id:
        return _cors(jsonify({"error": "auth create returned no id"})), 500

    # 2. Create the seller row. Instant-trial by default (status='active'
    #    + a trial window); falls back to 'paused' (approval-gated) when
    #    TRIAL_AUTO_ACTIVATE is off.
    from datetime import timedelta as _timedelta
    _now = datetime.now(timezone.utc)
    base_payload = {
        "business_name": business_name,
        "business_email": email,
        "country_codes": country_codes,
        "default_language": default_language,
    }
    if TRIAL_AUTO_ACTIVATE:
        trial_payload = dict(
            base_payload,
            status="active",
            is_trial=True,
            trial_started_at=_now.isoformat(),
            trial_ends_at=(_now + _timedelta(days=TRIAL_DAYS)).isoformat(),
            trial_conversations_cap=TRIAL_CONVERSATIONS_CAP,
        )
        seller_row = _supa_post("sellers", trial_payload)
        if not seller_row:
            # Older DBs may not have the trial columns yet (migration 0013
            # not applied) — retry with just status so the seller still
            # gets instant access on the legacy schema.
            log.warning("[signup] trial insert failed — retrying without trial columns")
            seller_row = _supa_post("sellers", dict(base_payload, status="active"))
    else:
        seller_row = _supa_post("sellers", dict(base_payload, status="paused"))
    if not seller_row:
        # Roll back the auth user so a re-signup can succeed.
        try:
            httpx.delete(
                f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}",
                headers={
                    "apikey": SUPABASE_SERVICE_KEY,
                    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                },
                timeout=10,
                verify=_SUPA_VERIFY,
            )
        except Exception:
            pass
        return _cors(jsonify({"error": "could not create seller profile"})), 500
    seller_id = seller_row.get("id")

    # 3. Link auth user → seller via app_users.
    link = _supa_post("app_users", {
        "id": user_id,
        "seller_id": seller_id,
        "role": "seller",
    })
    if not link:
        # Best-effort rollback — keep going regardless; admin can clean up.
        log.warning("[signup] app_users link failed for user_id=%s seller_id=%s", user_id, seller_id)

    trial_active = TRIAL_AUTO_ACTIVATE and seller_row.get("status") == "active"
    if trial_active:
        return _cors(jsonify({
            "ok": True,
            "status": "trial_active",
            "trial": True,
            "trial_days": TRIAL_DAYS,
            "trial_conversations": TRIAL_CONVERSATIONS_CAP,
            "message": (
                f"Account created. Your free {TRIAL_DAYS}-day trial "
                f"({TRIAL_CONVERSATIONS_CAP} conversations) is live — "
                "you can start using the bot right away."
            ),
            "seller_id": seller_id,
            "business_name": business_name,
        })), 201

    return _cors(jsonify({
        "ok": True,
        "status": "pending_approval",
        "message": "Account created. An administrator will review and approve your access shortly.",
        "seller_id": seller_id,
        "business_name": business_name,
    })), 201


# ────────────────────────────────────────────────────────────────────────
# PUBLIC AUTH CONFIG + GOOGLE OAUTH
#
# /funnel/auth/config  → hands the frontend the *public* Supabase URL +
#                        anon key so it can run the Google OAuth redirect
#                        flow client-side. The anon key is public by design
#                        (protected by RLS); the service_role key is never
#                        exposed here.
# /funnel/auth/oauth   → after Google → Supabase returns a session, the
#                        dashboard POSTs the access_token here. We verify it,
#                        then find-or-create the seller (instant trial for a
#                        first-time Google user) and hand back the same
#                        payload shape as /funnel/auth/login.
# ────────────────────────────────────────────────────────────────────────

@app.route("/funnel/auth/config", methods=["GET", "OPTIONS"])
def funnel_auth_config():
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    anon = os.environ.get("SUPABASE_ANON_KEY", "")
    return _cors(jsonify({
        "supabase_url": SUPABASE_URL,
        "supabase_anon_key": anon,
        # The frontend shows "Continue with Google" only when Supabase is
        # wired. Whether the Google *provider* is actually enabled lives in
        # the Supabase dashboard; if it isn't, the redirect surfaces a
        # provider error which the dashboard displays.
        "google_oauth": bool(SUPABASE_URL and anon),
    })), 200


def _seller_login_payload(seller_id, role, email, access_token=""):
    """Shared success shape for login / oauth — mirrors funnel_auth_login."""
    seller = fetch_seller(seller_id) or {}
    return {
        "ok": True,
        "role": role,
        "seller_id": seller_id,
        "business_name": seller.get("business_name"),
        "email": email,
        "access_token": access_token,
        "openwa_api_key": seller.get("openwa_api_key") or OPENWA_API_KEY or "",
        "openwa_api_url": seller.get("openwa_api_url") or OPENWA_API_URL or "",
        "openwa_session_id": seller.get("openwa_session_id") or OPENWA_SESSION_ID or "",
    }


@app.route("/funnel/auth/oauth", methods=["POST", "OPTIONS"])
def funnel_auth_oauth():
    """Exchange a Supabase OAuth session (Google) for a dashboard login.

    Body: { access_token, country_code?, default_language? }

      - Existing user (has an app_users row) → same as email/password login.
      - First-time OAuth user → auto-create the seller row (instant trial,
        mirroring signup) so they land straight in the dashboard.
    """
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    body = request.get_json(silent=True) or {}
    access_token = (body.get("access_token") or "").strip()
    if not access_token:
        return _cors(jsonify({"error": "access_token required"})), 400

    user = _supa_auth_user_from_token(access_token)
    if not user or not user.get("id"):
        return _cors(jsonify({"error": "invalid or expired session"})), 401

    user_id = user["id"]
    email = (user.get("email") or "").strip().lower()
    meta = user.get("user_metadata") or {}

    # Already onboarded? Treat exactly like a normal login.
    app_user_rows = _supa_get("app_users", {
        "id": f"eq.{user_id}",
        "select": "seller_id,role",
        "limit": "1",
    }) or []

    if app_user_rows:
        role = app_user_rows[0].get("role") or "seller"
        seller_id = app_user_rows[0].get("seller_id")
        if role == "admin":
            return _cors(jsonify({
                "ok": True,
                "role": "admin",
                "email": email,
                "access_token": access_token,
                "openwa_api_url": OPENWA_API_URL or "",
                "openwa_api_key": OPENWA_API_KEY or "",
                "openwa_session_id": OPENWA_SESSION_ID or "",
            })), 200

        seller = fetch_seller(seller_id) or {}
        seller_status = (seller.get("status") or "active").lower()
        if seller_status == "paused":
            return _cors(jsonify({
                "error": "pending_approval",
                "message": "Your account is awaiting admin approval.",
                "business_name": seller.get("business_name"),
            })), 403
        if seller_status == "disabled":
            return _cors(jsonify({
                "error": "account_suspended",
                "message": "Your account has been suspended. Contact support.",
            })), 403
        return _cors(jsonify(_seller_login_payload(seller_id, role, email, access_token))), 200

    # ── First-time Google user → create a seller (instant trial). ──────────
    # OAuth never collected a business name, so seed it from the Google
    # profile (full name) or the email local-part; the seller renames it
    # later in Settings.
    business_name = (
        meta.get("business_name")
        or meta.get("full_name")
        or meta.get("name")
        or (email.split("@")[0] if email else "")
        or "My Shop"
    ).strip() or "My Shop"
    default_language = (body.get("default_language") or "en").lower()
    cc = body.get("country_code") or ""
    country_codes = [cc.strip().upper()] if isinstance(cc, str) and cc.strip() else []

    from datetime import timedelta as _timedelta
    _now = datetime.now(timezone.utc)
    base_payload = {
        "business_name": business_name,
        "business_email": email,
        "country_codes": country_codes,
        "default_language": default_language,
    }
    if TRIAL_AUTO_ACTIVATE:
        seller_row = _supa_post("sellers", dict(
            base_payload,
            status="active",
            is_trial=True,
            trial_started_at=_now.isoformat(),
            trial_ends_at=(_now + _timedelta(days=TRIAL_DAYS)).isoformat(),
            trial_conversations_cap=TRIAL_CONVERSATIONS_CAP,
        ))
        if not seller_row:
            log.warning("[oauth] trial insert failed — retrying without trial columns")
            seller_row = _supa_post("sellers", dict(base_payload, status="active"))
    else:
        seller_row = _supa_post("sellers", dict(base_payload, status="paused"))

    if not seller_row:
        return _cors(jsonify({"error": "could not create seller profile"})), 500
    seller_id = seller_row.get("id")

    link = _supa_post("app_users", {
        "id": user_id,
        "seller_id": seller_id,
        "role": "seller",
    })
    if not link:
        log.warning("[oauth] app_users link failed for user_id=%s seller_id=%s", user_id, seller_id)

    seller_status = (seller_row.get("status") or "").lower()
    if not TRIAL_AUTO_ACTIVATE or seller_status != "active":
        return _cors(jsonify({
            "error": "pending_approval",
            "message": "Account created. An administrator will review and approve your access shortly.",
            "business_name": business_name,
        })), 403

    payload = _seller_login_payload(seller_id, "seller", email, access_token)
    payload["status"] = "trial_active"
    payload["trial"] = True
    payload["new_account"] = True
    return _cors(jsonify(payload)), 201


@app.route("/funnel/auth/oauth/complete", methods=["POST", "OPTIONS"])
def funnel_auth_oauth_complete():
    """Finish onboarding for a brand-new Google user.

    The dashboard calls this right after /funnel/auth/oauth returns
    new_account=true. The seller row already exists (oauth created it from
    the Google profile with default region/language); here we let the
    seller finish the profile from a dedicated screen:

      - set a PASSWORD, so they can also sign in with email + password
        later (not only "Continue with Google"),
      - pick their COUNTRY + bot LANGUAGE.

    Body: { access_token, password?, country_code?, default_language?,
            business_name? }

    Returns the same login payload shape as /funnel/auth/oauth so the
    dashboard drops them straight into their account.
    """
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    body = request.get_json(silent=True) or {}
    access_token = (body.get("access_token") or "").strip()
    if not access_token:
        return _cors(jsonify({"error": "access_token required"})), 400

    user = _supa_auth_user_from_token(access_token)
    if not user or not user.get("id"):
        return _cors(jsonify({"error": "invalid or expired session"})), 401
    user_id = user["id"]
    email = (user.get("email") or "").strip().lower()

    # The seller must already exist (created by /funnel/auth/oauth). If it
    # doesn't, the client skipped a step — tell it to start over.
    rows = _supa_get("app_users", {
        "id": f"eq.{user_id}",
        "select": "seller_id,role",
        "limit": "1",
    }) or []
    if not rows:
        return _cors(jsonify({
            "error": "no_profile",
            "message": "Sign in with Google first.",
        })), 404
    role = rows[0].get("role") or "seller"
    seller_id = rows[0].get("seller_id")

    # 1. Optional password → lets the seller use email + password login too.
    #    Setting it on the Google-created auth user is a no-op for the OAuth
    #    flow but unlocks the email/password path. Non-fatal on failure:
    #    they can always come back via "Continue with Google".
    password = body.get("password") or ""
    if password:
        if len(password) < 8:
            return _cors(jsonify({"error": "password must be at least 8 characters"})), 400
        if SUPABASE_URL and SUPABASE_SERVICE_KEY:
            try:
                pr = httpx.put(
                    f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}",
                    headers={
                        "apikey": SUPABASE_SERVICE_KEY,
                        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                        "Content-Type": "application/json",
                    },
                    json={"password": password},
                    timeout=15,
                    verify=_SUPA_VERIFY,
                )
                if pr.status_code not in (200, 201):
                    log.warning("[oauth/complete] set-password HTTP %s", pr.status_code)
            except Exception as exc:
                log.warning("[oauth/complete] set password failed: %s", exc)

    # 2. Update the seller's region / language / name from the form.
    updates: dict = {}
    cc = body.get("country_code") or ""
    if isinstance(cc, str) and cc.strip():
        updates["country_codes"] = [cc.strip().upper()]
    lang = (body.get("default_language") or "").strip().lower()
    if lang:
        updates["default_language"] = lang
    bn = (body.get("business_name") or "").strip()
    if bn:
        updates["business_name"] = bn
    if updates and seller_id:
        _supa_patch("sellers", {"id": seller_id}, updates)

    payload = _seller_login_payload(seller_id, role, email, access_token)
    payload["status"] = "trial_active"
    payload["trial"] = True
    return _cors(jsonify(payload)), 200


# ────────────────────────────────────────────────────────────────────────
# ADMIN ENDPOINTS — list / approve / reject sellers
#
# All require Authorization: Bearer <admin_access_token>.
# ────────────────────────────────────────────────────────────────────────

@app.route("/funnel/admin/sellers", methods=["GET", "OPTIONS"])
def funnel_admin_sellers():
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    if not _require_admin():
        return _cors(jsonify({"error": "admin authentication required"})), 401

    status_filter = (request.args.get("status") or "").lower()
    params = {
        "select": "id,business_name,business_email,country_codes,default_language,status,created_at",
        "order": "created_at.desc",
        "limit": "200",
    }
    if status_filter in ("pending", "paused", "active", "disabled"):
        # 'pending' is the UI-facing alias for the internal 'paused' state.
        internal = "paused" if status_filter == "pending" else status_filter
        params["status"] = f"eq.{internal}"

    rows = _supa_get("sellers", params) or []

    # Decorate with email-friendly status + counts so the admin UI can
    # render badges without an extra round-trip.
    for row in rows:
        row["display_status"] = "pending" if row.get("status") == "paused" else row.get("status")

    return _cors(jsonify({"sellers": rows})), 200


@app.route("/funnel/admin/sellers/<seller_id>/approve", methods=["POST", "OPTIONS"])
def funnel_admin_approve(seller_id: str):
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    if not _require_admin():
        return _cors(jsonify({"error": "admin authentication required"})), 401
    ok = _supa_patch("sellers", {"id": seller_id}, {"status": "active"})
    if not ok:
        return _cors(jsonify({"error": "could not approve seller"})), 500
    return _cors(jsonify({"ok": True, "seller_id": seller_id, "status": "active"})), 200


@app.route("/funnel/admin/sellers/<seller_id>/reject", methods=["POST", "OPTIONS"])
def funnel_admin_reject(seller_id: str):
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    if not _require_admin():
        return _cors(jsonify({"error": "admin authentication required"})), 401
    ok = _supa_patch("sellers", {"id": seller_id}, {"status": "disabled"})
    if not ok:
        return _cors(jsonify({"error": "could not reject seller"})), 500
    return _cors(jsonify({"ok": True, "seller_id": seller_id, "status": "disabled"})), 200


# ── Admin system settings (OpenRouter key + model) ──────────────────────
def _mask_key(k: str) -> str:
    """Show only the first 6 and last 4 chars so the admin can confirm
    they pasted the right thing without exposing the full secret to
    anyone shoulder-surfing."""
    if not k:
        return ""
    if len(k) <= 12:
        return "•" * len(k)
    return f"{k[:6]}…{k[-4:]}"


@app.route("/funnel/admin/settings", methods=["GET", "POST", "OPTIONS"])
def funnel_admin_settings():
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    if not _require_admin():
        return _cors(jsonify({"error": "admin authentication required"})), 401

    if request.method == "GET":
        key = get_openrouter_key()
        # Effective payment methods = admin override (system_settings) merged
        # over the built-in defaults, per country. The admin edits these so the
        # REAL RIB / Orange Money numbers live in the DB (never in git).
        _pm_override = _load_system_settings().get("payment_methods") or {}
        _pm_effective = {**DEFAULT_PAYMENT_METHODS, **_pm_override}
        return _cors(jsonify({
            "openrouter_key_masked":  _mask_key(key),
            "openrouter_key_present": bool(key),
            "openrouter_model":       get_openrouter_model(),
            "default_openwa_api_url": OPENWA_API_URL,
            "default_openwa_session": OPENWA_SESSION_ID,
            "supabase_url":           SUPABASE_URL,
            "payment_methods":          _pm_effective,
            "payment_methods_override": _pm_override,
            "default_payment_methods":  DEFAULT_PAYMENT_METHODS,
        })), 200

    # POST — accept any subset of writable settings.
    body = request.get_json(silent=True) or {}
    updates: List[str] = []

    if "openrouter_api_key" in body:
        v = (body.get("openrouter_api_key") or "").strip()
        # Empty string = "clear" the override and fall back to env.
        set_system_setting("openrouter_api_key", v or None)
        updates.append("openrouter_api_key")

    if "openrouter_model" in body:
        v = (body.get("openrouter_model") or "").strip()
        set_system_setting("openrouter_model", v or None)
        updates.append("openrouter_model")

    # Payment methods — per-country bank/mobile-money details shown to sellers
    # on the Billing page. Stored in system_settings (private DB), so the admin
    # can put real RIB / Orange Money numbers without committing them to git.
    # Expects { "MA": [{method,label,details,instructions}, ...], "SN": [...] }.
    if "payment_methods" in body:
        pm = body.get("payment_methods")
        if isinstance(pm, dict):
            # Drop empty-country entries so the resolver falls back to defaults.
            cleaned = {str(k).upper(): v for k, v in pm.items()
                       if isinstance(v, list) and len(v) > 0}
            set_system_setting("payment_methods", cleaned)
            updates.append("payment_methods")
        else:
            return _cors(jsonify({"error": "payment_methods must be an object keyed by country code"})), 400

    return _cors(jsonify({"ok": True, "updated": updates})), 200


# ── Image upload (product photos → Supabase Storage) ────────────────────
@app.route("/funnel/upload/product-image", methods=["POST", "OPTIONS"])
def funnel_upload_product_image():
    """Accepts a multipart 'file' from sellers / admin and pushes it to
    the Supabase Storage bucket 'product-images'. Returns the public URL
    so the dashboard can save it on the product row's image_url field.

    Auth: a seller (resolved via the X-Seller-Id header / leadecombot
    seller-id session) OR a platform admin (Bearer token).
    """
    if request.method == "OPTIONS":
        return _cors(jsonify({}))

    is_admin = _require_admin() is not None
    seller_id = _funnel_seller_id() if not is_admin else None
    if not (is_admin or seller_id):
        return _cors(jsonify({"error": "unauthorised"})), 401

    f = request.files.get("file")
    if not f:
        return _cors(jsonify({"error": "no file uploaded (expect multipart field 'file')"})), 400

    mime = (f.mimetype or "").lower()
    if mime not in ("image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"):
        return _cors(jsonify({"error": f"unsupported file type: {mime}"})), 415

    raw = f.read()
    if not raw:
        return _cors(jsonify({"error": "empty file"})), 400
    if len(raw) > 5 * 1024 * 1024:
        return _cors(jsonify({"error": "file too large (5MB max)"})), 413

    if not (SUPABASE_URL and SUPABASE_SERVICE_KEY):
        return _cors(jsonify({"error": "supabase storage not configured"})), 500

    # Path: <seller_id_or_admin>/<random>.<ext> — random component avoids
    # collisions if two browser tabs upload at the same instant.
    ext = {"image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg",
           "image/webp": "webp", "image/gif": "gif"}.get(mime, "bin")
    bucket = "product-images"
    folder = "admin" if is_admin else seller_id
    path = f"{folder}/{uuid.uuid4().hex}.{ext}"

    try:
        r = httpx.post(
            f"{SUPABASE_URL}/storage/v1/object/{bucket}/{path}",
            content=raw,
            headers={
                "apikey": SUPABASE_SERVICE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                "Content-Type": mime,
                "x-upsert": "true",
            },
            timeout=30,
            verify=_SUPA_VERIFY,
        )
    except Exception as exc:
        log.warning("[upload] storage POST failed: %s", exc)
        return _cors(jsonify({"error": "upload failed", "detail": str(exc)})), 502

    if r.status_code not in (200, 201):
        return _cors(jsonify({
            "error": "storage rejected the upload",
            "status": r.status_code,
            "detail": r.text[:300],
        })), 502

    public_url = f"{SUPABASE_URL}/storage/v1/object/public/{bucket}/{path}"
    return _cors(jsonify({
        "ok": True,
        "url": public_url,
        "path": path,
        "bucket": bucket,
        "size": len(raw),
        "mime": mime,
    })), 201


@app.route("/funnel/products", methods=["GET", "POST", "OPTIONS"])
def funnel_products():
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    seller_id = _funnel_seller_id()
    if not seller_id:
        return _cors(jsonify({"error": "no seller resolved"})), 400

    if request.method == "GET":
        rows = list_seller_products(seller_id) or []
        return _cors(jsonify({"products": rows}))

    if not _funnel_only_localhost():
        return _cors(jsonify({"error": "forbidden"})), 403

    # Free-trial hard gate — once the trial ends (and no active paid plan)
    # the seller can't add products/services until an admin activates a plan.
    _acc = _seller_access_state(seller_id)
    if not _acc.get("allowed"):
        log.info("[funnel] seller %s blocked from create (%s)", seller_id, _acc.get("reason"))
        return _trial_blocked_response(_acc, "create_product")

    body = request.get_json(silent=True) or {}
    # Insert product row
    product_row = {
        "seller_id":           seller_id,
        "name":                (body.get("name") or "").strip() or "Untitled",
        "description":         body.get("description") or None,
        "image_url":           body.get("image_url") or None,
        "aliases":             body.get("aliases") or [],
        "status":              body.get("status") or "active",
        "sheets_webhook_url":  body.get("sheets_webhook_url") or None,
        # 0006 — sessions this product is pinned to. Defensive default so
        # the request works whether the migration has been applied or not
        # (Supabase silently ignores unknown columns? no — it errors. So
        # only include the key when the dashboard sent it).
    }
    if isinstance(body.get("whatsapp_session_ids"), list):
        product_row["whatsapp_session_ids"] = [
            str(x).strip() for x in body["whatsapp_session_ids"] if str(x).strip()
        ]
    if isinstance(body.get("gallery_urls"), list):
        product_row["gallery_urls"] = [
            str(x).strip() for x in body["gallery_urls"]
            if isinstance(x, str) and x.strip().startswith(("http://", "https://"))
        ]
    kind_value = (body.get("kind") or "").strip().lower()
    if kind_value in ("product", "service"):
        product_row["kind"] = kind_value
    # 0012 — universal "Any Service" extraction schema. Persist whatever
    # the dashboard editor configured (storage view KEEPS phone so the
    # Téléphone toggle round-trips; the runtime view drops it).
    if isinstance(body.get("custom_fields"), list):
        product_row["custom_fields"] = _sanitize_custom_fields_for_storage(
            body["custom_fields"])
    inserted = _supa_post("products", product_row)
    # If the insert failed because a recent migration isn't applied yet
    # (column missing → PostgREST PGRST204), retry progressively without
    # the optional columns so the rest of the product still saves.
    # 0012 (custom_fields) is the newest column, so drop it first.
    if not inserted and "custom_fields" in product_row:
        product_row.pop("custom_fields", None)
        inserted = _supa_post("products", product_row)
    if not inserted and "kind" in product_row:
        product_row.pop("kind", None)
        inserted = _supa_post("products", product_row)
    if not inserted and "gallery_urls" in product_row:
        product_row.pop("gallery_urls", None)
        inserted = _supa_post("products", product_row)
    if not inserted and "whatsapp_session_ids" in product_row:
        product_row.pop("whatsapp_session_ids", None)
        inserted = _supa_post("products", product_row)
    if not inserted:
        return _cors(jsonify({"error": "insert failed"})), 500
    # Optional per-country pricing row (single-market common case)
    pc = body.get("country") or {}
    if pc and pc.get("country_code"):
        _supa_post("product_countries", {
            "product_id":     inserted["id"],
            "country_code":   (pc.get("country_code") or "").upper(),
            "language_code":  pc.get("language_code") or "fr",
            "price":          float(pc.get("price") or 0),
            "currency":       pc.get("currency") or "GNF",
            "price_tiers":    pc.get("price_tiers") or {},
            "available":      True,
        })
    return _cors(jsonify({"ok": True, "product": inserted})), 201


@app.route("/funnel/products/<pid>", methods=["PATCH", "DELETE", "OPTIONS"])
def funnel_product_detail(pid: str):
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    if not _funnel_only_localhost():
        return _cors(jsonify({"error": "forbidden"})), 403
    if request.method == "DELETE":
        ok = _supa_patch("products", {"id": pid}, {"status": "archived"})
        return _cors(jsonify({"ok": ok}))
    body = request.get_json(silent=True) or {}
    allowed = {"name", "description", "image_url", "aliases", "status",
               "sheets_webhook_url", "whatsapp_session_ids", "gallery_urls",
               "kind", "custom_fields"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if "whatsapp_session_ids" in updates and isinstance(updates["whatsapp_session_ids"], list):
        updates["whatsapp_session_ids"] = [
            str(x).strip() for x in updates["whatsapp_session_ids"] if str(x).strip()
        ]
    if "gallery_urls" in updates and isinstance(updates["gallery_urls"], list):
        updates["gallery_urls"] = [
            str(x).strip() for x in updates["gallery_urls"]
            if isinstance(x, str) and x.strip().startswith(("http://", "https://"))
        ]
    if "kind" in updates:
        kind_value = str(updates["kind"] or "").strip().lower()
        if kind_value not in ("product", "service"):
            updates.pop("kind")
        else:
            updates["kind"] = kind_value
    # 0012 — sanitize the extraction schema before persisting (KEEPS phone
    # so the editor toggle round-trips).
    if "custom_fields" in updates:
        updates["custom_fields"] = _sanitize_custom_fields_for_storage(
            updates["custom_fields"])
    if updates:
        # If the dashboard sent a column that hasn't been migrated yet,
        # Supabase returns 400. Progressively drop the optional fields
        # and retry so the rest of the edit still goes through. Newest
        # column (custom_fields, 0012) is dropped first.
        if not _supa_patch("products", {"id": pid}, updates):
            updates.pop("custom_fields", None)
            if updates and not _supa_patch("products", {"id": pid}, updates):
                updates.pop("kind", None)
                if updates and not _supa_patch("products", {"id": pid}, updates):
                    updates.pop("gallery_urls", None)
                    if updates and not _supa_patch("products", {"id": pid}, updates):
                        updates.pop("whatsapp_session_ids", None)
                        if updates:
                            _supa_patch("products", {"id": pid}, updates)
    # Optionally update the per-country pricing row in one call.
    pc = body.get("country") or {}
    if pc and pc.get("id"):
        pc_updates = {k: v for k, v in pc.items() if k in
                      ("country_code", "language_code", "price", "currency",
                       "price_tiers", "available", "translated_name",
                       "translated_description")}
        if "country_code" in pc_updates and pc_updates["country_code"]:
            pc_updates["country_code"] = pc_updates["country_code"].upper()
        _supa_patch("product_countries", {"id": pc["id"]}, pc_updates)
    return _cors(jsonify({"ok": True}))


@app.route("/funnel/billing/usage", methods=["GET", "OPTIONS"])
def funnel_billing_usage():
    """Per-organization AI usage snapshot for the dashboard's top-bar
    Tokens IA counter + the Billing page chart.

    Returns:
      • plan                — 'free' | 'starter' | 'pro' | 'business'
      • ai_tokens_balance   — current remaining tokens (live)
      • preferred_currency  — display currency code (e.g. 'USD')
      • organization_id     — id of the org we resolved to
      • organization_name   — display name for the top bar
      • usage_7d            — [{ day: 'YYYY-MM-DD', total_tokens: int }] for the chart
      • migration_applied   — false when 0009 hasn't been applied yet
                              (dashboard gracefully degrades instead of
                              showing 500 errors).
    """
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    seller_id = _funnel_seller_id()
    if not seller_id:
        return _cors(jsonify({"error": "no seller resolved"})), 400

    # business_category (migration 0009) drives the dashboard's dynamic
    # multi-service UI — page titles, column headers, filter tabs, stat
    # cards, terminology all adapt to the seller's vertical. Fetch it once
    # here so EVERY return path below can surface it. Defensive: when the
    # column doesn't exist yet (pre-0009) the dashboard treats the seller
    # as generic e-commerce, so a null is perfectly safe.
    business_category = None
    try:
        _srows = _supa_get("sellers", {
            "id": f"eq.{seller_id}",
            "select": "business_category",
            "limit": "1",
        })
        if _srows:
            business_category = _srows[0].get("business_category") or None
    except Exception:
        business_category = None

    # Free-trial snapshot — computed for EVERY return path (including the
    # pre-0009 placeholders below) so the dashboard trial banner works even
    # when the organizations/billing migration hasn't been applied. The trial
    # derives from sellers.created_at when its own columns are absent, so it's
    # independent of the billing schema.
    trial = _trial_status_for_seller(seller_id)
    # Access gate snapshot — drives the dashboard's "trial ended → choose a
    # plan" block + button disabling. Computed for EVERY return path below.
    access = _seller_access_state(seller_id)

    org_id = _resolve_organization_id_for_seller(seller_id)
    if not org_id:
        # Migration 0009 not applied — return a soft placeholder so the
        # dashboard can render an empty state without exploding.
        return _cors(jsonify({
            "plan": "free",
            "ai_tokens_balance": 0,
            "preferred_currency": "USD",
            "organization_id": None,
            "organization_name": None,
            "business_category": business_category,
            "usage_7d": [],
            "migration_applied": False,
            "access": access,
            **trial,
        }))

    try:
        # 0010 adds country_code + monthly_token_grant + period_*.
        # Defensive select: brain falls back to v1-only columns when
        # migration 0010 isn't applied yet so the dashboard stays alive.
        rows = _supa_get("organizations", {
            "id": f"eq.{org_id}",
            "select": (
                "id,name,plan,ai_tokens_balance,preferred_currency,"
                "country_code,monthly_token_grant,period_starts_at,period_ends_at"
            ),
            "limit": "1",
        })
    except Exception:
        try:
            rows = _supa_get("organizations", {
                "id": f"eq.{org_id}",
                "select": "id,name,plan,ai_tokens_balance,preferred_currency",
                "limit": "1",
            })
        except Exception:
            rows = []
    if not rows:
        return _cors(jsonify({
            "plan": "free", "tier": "free",
            "ai_tokens_balance": 0,
            "monthly_token_grant": FREE_TIER_MONTHLY_TOKENS,
            "sessions_included": FREE_TIER_SESSIONS,
            "fair_use_percent": 0,
            "preferred_currency": "USD", "organization_id": org_id,
            "organization_name": None, "usage_7d": [],
            "business_category": business_category,
            "country_code": None, "period_ends_at": None,
            "days_to_renewal": 0, "migration_applied": False,
            "access": access,
            **trial,
        }))
    org = rows[0]

    # Pull last 7 days of usage, bucket per day in Python (small dataset).
    from datetime import datetime as _dt, timezone as _tz, timedelta as _td
    now_utc = _dt.now(_tz.utc)
    seven_ago = (now_utc - _td(days=7)).isoformat()
    try:
        usage_rows = _supa_get("ai_usage_log", {
            "organization_id": f"eq.{org_id}",
            "created_at": f"gte.{seven_ago}",
            "select": "total_tokens,created_at",
            "order": "created_at.asc",
            "limit": "5000",
        })
    except Exception:
        usage_rows = []
    buckets: Dict[str, int] = {}
    for r in usage_rows:
        day = (r.get("created_at") or "")[:10]
        if day:
            buckets[day] = buckets.get(day, 0) + int(r.get("total_tokens") or 0)
    usage_7d = [{"day": d, "total_tokens": t}
                for d, t in sorted(buckets.items())]

    # Resolve the org's active subscription to know which tier rules
    # apply right now. No active row → free tier.
    tier = "free"
    sessions_included = FREE_TIER_SESSIONS
    try:
        sub_rows = _supa_get("subscriptions", {
            "organization_id": f"eq.{org_id}",
            "status": "eq.active",
            "select": "tier",
            "order": "started_at.desc",
            "limit": "1",
        })
        if sub_rows:
            tier = sub_rows[0].get("tier") or "free"
    except Exception:
        # subscriptions table missing — migration 0010 not applied.
        pass
    tier_cfg = PRICING_TIERS.get(tier, {})
    if tier_cfg:
        sessions_included = tier_cfg.get("sessions_included", FREE_TIER_SESSIONS)

    # Fair-use percent: how much of the monthly grant has been used.
    # Marketing-friendly metric — we surface this instead of raw tokens
    # so "unlimited chats" stays true (sellers don't see a token count
    # to fret over).
    grant = int(org.get("monthly_token_grant") or FREE_TIER_MONTHLY_TOKENS)
    balance = int(org.get("ai_tokens_balance") or 0)
    used = max(0, grant - balance)
    fair_use_percent = 0 if grant <= 0 else min(100, round(100 * used / grant))

    # Days to renewal — shown as a small badge in the top bar.
    days_to_renewal = 0
    period_ends_at = org.get("period_ends_at")
    if period_ends_at:
        try:
            ends_dt = _dt.fromisoformat(str(period_ends_at).replace("Z", "+00:00"))
            days_to_renewal = max(0, int((ends_dt - now_utc).total_seconds() // 86400))
        except Exception:
            days_to_renewal = 0

    # Free-trial status — drives the Billing page banner + top-bar nudge
    # for self-serve signups. Defensive: returns is_trial=False on any
    # error / unmigrated DB so paid sellers see no trial UI.
    trial = _trial_status_for_seller(seller_id)

    return _cors(jsonify({
        "plan": org.get("plan") or "free",
        "tier": tier,
        "ai_tokens_balance": balance,
        "monthly_token_grant": grant,
        "fair_use_percent": fair_use_percent,
        "sessions_included": sessions_included,
        "preferred_currency": (
            org.get("preferred_currency")
            or _resolve_currency_for_country(org.get("country_code"))
        ),
        "country_code": (org.get("country_code") or "").upper() or None,
        "period_starts_at": org.get("period_starts_at"),
        "period_ends_at": period_ends_at,
        "days_to_renewal": days_to_renewal,
        "organization_id": org.get("id"),
        "organization_name": org.get("name"),
        "business_category": business_category,
        "usage_7d": usage_7d,
        "is_trial": trial.get("is_trial", False),
        "trial_ends_at": trial.get("trial_ends_at"),
        "trial_days_left": trial.get("trial_days_left", 0),
        "trial_conversations_used": trial.get("trial_conversations_used", 0),
        "trial_conversations_cap": trial.get("trial_conversations_cap", TRIAL_CONVERSATIONS_CAP),
        "access": access,
        "migration_applied": True,
    }))


# Token-pack catalogue. Operator can tune these later in
# system_settings.json; defaults match the 3-card store the Billing
# page renders. Prices are USD cents.
# ════════════════════════════════════════════════════════════════════════
# PRICING (v2 — subscription tiers in local African currency)
# ════════════════════════════════════════════════════════════════════════
#
# All amounts in MINOR units (USD cents, MAD centimes, XOF franc, GNF
# franc — XOF/GNF have no subunit so the "cents" value equals the franc
# amount × 1). Source of truth — dashboard reads via /funnel/billing/plans
# so price changes don't need a frontend rebuild.

# 3 packs (Closwiz) — Starter $17 / Growth $24 / Scale $42 — marketed as
# "unlimited products / unlimited chats" with a per-month CONVERSATION cap,
# and an INTERNAL token "Fair use" meter as the hard guard. The AI cascade
# (cheap gpt-4o-mini on routine turns, premium only on the closing turn)
# keeps LLM cost ~4-5× lower, so margins stay healthy at every tier:
#   Starter — $17 · 1 WhatsApp · ~500 conversations/mo
#   Growth  — $24 · 3 WhatsApp · ~1 500 conversations/mo   (most popular)
#   Scale   — $42 · 5 WhatsApp · ~3 000 conversations/mo
# NOTE: the tier id 'pro' is KEPT (so existing subscriptions don't break) but
# it is now labelled "Growth". Zero-decimal currencies (XOF/GNF/XAF) store ×1.
PRICING_TIERS: Dict[str, Dict[str, Any]] = {
    "starter": {
        "label":             "Starter",
        "monthly_tokens":    1_000_000,   # internal fair-use cap (hidden)
        "sessions_included": 1,
        "prices": {
            "USD":   1700,   # $17
            "MAD":  17000,   # 170 MAD
            "XOF":   10000,  # 10 000 XOF
            "GNF":  150000,  # 150 000 GNF
            "XAF":   11000,  # 11 000 XAF
            "EGP":   85000,  # 850 EGP
        },
    },
    "pro": {                              # shown as "Growth" (id kept for existing subs)
        "label":             "Growth",
        "monthly_tokens":  3_000_000,
        "sessions_included": 3,
        "prices": {
            "USD":   2400,   # $24
            "MAD":  24000,   # 240 MAD
            "XOF":   14000,  # 14 000 XOF
            "GNF":  210000,  # 210 000 GNF
            "XAF":   16000,  # 16 000 XAF
            "EGP":  120000,  # 1 200 EGP
        },
    },
    "scale": {
        "label":             "Scale",
        "monthly_tokens":  6_000_000,
        "sessions_included": 5,
        "prices": {
            "USD":   4200,   # $42
            "MAD":  42000,   # 420 MAD
            "XOF":   25000,  # 25 000 XOF
            "GNF":  370000,  # 370 000 GNF
            "XAF":   28000,  # 28 000 XAF
            "EGP":  210000,  # 2 100 EGP
        },
    },
}

# Free tier — no row in PRICING_TIERS because it costs nothing. Brain
# uses these constants to seed new organizations and to fall back when
# a subscription expires.
FREE_TIER_MONTHLY_TOKENS = 50_000
FREE_TIER_SESSIONS = 1
# WhatsApp numbers a FREE-TRIAL seller may link. The trial card promises
# exactly one ("1 WhatsApp session") — enforced on session create/register.
TRIAL_SESSIONS = 1

# ── Free trial for self-serve signups ──────────────────────────────────
# A brand-new seller who signs up through the landing page gets INSTANT
# access (no waiting for manual admin approval) for a short window. The
# trial ends on whichever limit hits first:
#   • TRIAL_DAYS elapsed, OR
#   • TRIAL_CONVERSATIONS_CAP distinct customer conversations.
# Enforcement lives in process_inbound_message via _trial_allows_reply,
# which fails OPEN so a live/paid seller is never accidentally muted.
# Flip TRIAL_AUTO_ACTIVATE to False to restore approval-gated signup.
TRIAL_DAYS = 2
TRIAL_CONVERSATIONS_CAP = 30
TRIAL_AUTO_ACTIVATE = True
# Hard access gate: once the free trial ends (and no active paid plan),
# block self-serve account mutations — connecting WhatsApp sessions and
# creating products/services — until an admin activates a paid plan.
# Distinct from _trial_allows_reply (which only mutes the BOT). Flip to
# "0"/"false" to disable the hard block (e.g. for debugging) — the gate
# then computes state for the dashboard banner but never refuses an action.
TRIAL_HARD_BLOCK = os.environ.get("TRIAL_HARD_BLOCK", "1").strip().lower() not in (
    "0", "false", "no", "off", "")

# Per-currency overage top-up packs. Replaces v1's USD-only TOKEN_PACKS.
TOKEN_PACK_PRICING: Dict[str, Dict[str, Any]] = {
    "tokens_500k": {
        "tokens":   500_000,
        "label":    "500k tokens",
        "prices": {
            "USD":   500, "MAD":  5000, "XOF":   3000,
            "GNF":  45000, "XAF":   3500, "EGP":  25000,
        },
    },
    "tokens_2m": {
        "tokens": 2_000_000,
        "label":  "2M tokens",
        "prices": {
            "USD":  1500, "MAD": 15000, "XOF":   9000,
            "GNF": 130000, "XAF":  10000, "EGP":  73000,
        },
    },
    "tokens_10m": {
        "tokens":10_000_000,
        "label":  "10M tokens",
        "prices": {
            "USD":  6000, "MAD": 60000, "XOF":  36000,
            "GNF": 525000, "XAF":  39000, "EGP": 290000,
        },
    },
}

# Country → display currency. Anything not listed defaults to USD.
COUNTRY_TO_CURRENCY: Dict[str, str] = {
    # Morocco
    "MA": "MAD",
    # West African Economic Monetary Union (XOF franc) — 8 countries
    "SN": "XOF", "CI": "XOF", "BJ": "XOF", "TG": "XOF",
    "ML": "XOF", "BF": "XOF", "NE": "XOF", "GW": "XOF",
    # Guinea (own franc)
    "GN": "GNF",
    # Central African Franc (CEMAC) — 6 countries
    "CM": "XAF", "GA": "XAF", "CG": "XAF", "TD": "XAF", "CF": "XAF",
    # Egypt
    "EG": "EGP",
}

# Country → payment provider. Stripe natively supports Morocco + most
# international markets. CinetPay covers WAEMU + Guinea + CEMAC mobile
# money (Orange Money, MTN MoMo, Wave, Moov).
COUNTRY_TO_PROVIDER: Dict[str, str] = {
    "MA": "stripe", "EG": "stripe",
    "SN": "cinetpay", "CI": "cinetpay", "BJ": "cinetpay", "TG": "cinetpay",
    "ML": "cinetpay", "BF": "cinetpay", "NE": "cinetpay", "GW": "cinetpay",
    "GN": "cinetpay",
    "CM": "cinetpay", "GA": "cinetpay", "CG": "cinetpay",
    "TD": "cinetpay", "CF": "cinetpay",
}


def _resolve_currency_for_country(country_code: Optional[str]) -> str:
    """Map a country code (or None) to the display currency. USD is the
    universal fallback for anything we don't have specific pricing for."""
    return COUNTRY_TO_CURRENCY.get((country_code or "").upper(), "USD")


def _resolve_provider_for_country(country_code: Optional[str]) -> str:
    """Pick the payment provider for the country. Stripe is the global
    default for cards; CinetPay covers mobile-money markets where Stripe
    doesn't onboard small merchants."""
    return COUNTRY_TO_PROVIDER.get((country_code or "").upper(), "stripe")


def _resolve_org_country(org: Dict) -> str:
    """Resolve an org's country: explicit column wins, else first
    shipping country on the owning seller, else 'MA' (the default test
    market). Used by /funnel/billing/plans + /funnel/billing/subscribe."""
    cc = (org.get("country_code") or "").strip().upper()
    if cc:
        return cc
    # Fallback: read the first seller's country_codes array.
    try:
        sellers = _supa_get("sellers", {
            "organization_id": f"eq.{org.get('id')}",
            "select": "country_codes",
            "limit": "1",
        })
        if sellers:
            ccs = sellers[0].get("country_codes") or []
            if ccs:
                return str(ccs[0]).upper()
    except Exception:
        pass
    return "MA"


# Backwards-compat alias for the v1 endpoint code that still references
# `TOKEN_PACKS` (the simpler USD-only dict).
TOKEN_PACKS = {
    pid: {
        "tokens": pack["tokens"],
        "amount_cents": pack["prices"]["USD"],
        "label": pack["label"],
    }
    for pid, pack in TOKEN_PACK_PRICING.items()
}


@app.route("/funnel/billing/checkout", methods=["POST", "OPTIONS"])
def funnel_billing_checkout():
    """Initiates a token-pack purchase. Creates a pending token_packs
    row + (when STRIPE_SECRET_KEY is set in env) a Stripe Checkout
    Session. Returns the URL the dashboard should redirect to.

    Without Stripe configured, returns a stub URL pointing at
    /billing?stub=<pack_id> so devs can still walk the dashboard flow
    without a real payment provider.
    """
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    if not _funnel_only_localhost():
        return _cors(jsonify({"error": "forbidden"})), 403

    seller_id = _funnel_seller_id()
    if not seller_id:
        return _cors(jsonify({"error": "no seller resolved"})), 400
    org_id = _resolve_organization_id_for_seller(seller_id)
    if not org_id:
        return _cors(jsonify({"error": "migration_0009_not_applied"})), 503

    body = request.get_json(silent=True) or {}
    pack_id = (body.get("pack") or "").strip()
    pack = TOKEN_PACKS.get(pack_id)
    if not pack:
        return _cors(jsonify({"error": "unknown pack",
                              "available": list(TOKEN_PACKS.keys())})), 400

    # Insert pending pack record.
    inserted = _supa_post("token_packs", {
        "organization_id": org_id,
        "tokens":          pack["tokens"],
        "amount_cents":    pack["amount_cents"],
        "currency":        "USD",
        "status":          "pending",
    })
    if not inserted:
        return _cors(jsonify({"error": "could not create pack record"})), 500

    pack_row_id = inserted.get("id")
    stripe_key = os.environ.get("STRIPE_SECRET_KEY", "").strip()
    if not stripe_key:
        # Dev / no-Stripe-yet mode: return a stub URL the dashboard
        # can render a friendly "Stripe not configured" page for.
        return _cors(jsonify({
            "url": f"/billing?stub=1&pack={pack_id}&id={pack_row_id}",
            "stub": True,
            "pack": pack,
        }))

    # Real Stripe path. We do a lazy import so the brain works without
    # the stripe SDK installed.
    try:
        import stripe as _stripe   # type: ignore
        _stripe.api_key = stripe_key
        session = _stripe.checkout.Session.create(
            mode="payment",
            line_items=[{
                "price_data": {
                    "currency": "usd",
                    "product_data": {"name": f"Konvico — {pack['label']}"},
                    "unit_amount": pack["amount_cents"],
                },
                "quantity": 1,
            }],
            success_url=(body.get("success_url") or
                         "http://localhost:2886/billing?status=success"),
            cancel_url=(body.get("cancel_url") or
                        "http://localhost:2886/billing?status=cancelled"),
            metadata={
                "organization_id": org_id,
                "pack_row_id":     pack_row_id,
                "pack_id":         pack_id,
                "tokens":          str(pack["tokens"]),
            },
        )
        _supa_patch("token_packs", {"id": pack_row_id},
                    {"stripe_session_id": session.id})
        return _cors(jsonify({"url": session.url, "stub": False,
                              "pack": pack}))
    except Exception as exc:
        log.exception("[billing] stripe checkout creation failed: %s", exc)
        return _cors(jsonify({"error": "stripe_init_failed",
                              "detail": str(exc)[:200]})), 500


@app.route("/funnel/billing/stripe-webhook", methods=["POST", "OPTIONS"])
def funnel_billing_stripe_webhook():
    """Stripe webhook receiver. Validates the signature, finds the
    token_pack row by stripe_session_id (or by metadata.pack_row_id),
    marks it paid, and credits the tokens to the organization."""
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    secret = os.environ.get("STRIPE_WEBHOOK_SECRET", "").strip()
    payload = request.data
    sig = request.headers.get("Stripe-Signature", "")
    if secret:
        try:
            import stripe as _stripe   # type: ignore
            event = _stripe.Webhook.construct_event(payload, sig, secret)
        except Exception as exc:
            log.warning("[billing] stripe webhook signature invalid: %s", exc)
            return jsonify({"error": "bad_signature"}), 400
    else:
        # No signing secret set — treat the body as JSON and trust it.
        # ONLY safe in dev; ops MUST set STRIPE_WEBHOOK_SECRET in prod.
        try:
            event = json.loads(payload or b"{}")
        except Exception:
            return jsonify({"error": "bad_json"}), 400

    evt_type = (event.get("type") if isinstance(event, dict)
                else getattr(event, "type", "")) or ""
    data = (event.get("data", {}).get("object", {})
            if isinstance(event, dict)
            else getattr(event, "data", {}).get("object", {}))

    if evt_type != "checkout.session.completed":
        # Ignore everything else — refunds and disputes handled later.
        return jsonify({"ok": True, "ignored": evt_type})

    session_id = (data.get("id") if isinstance(data, dict)
                  else getattr(data, "id", "")) or ""
    metadata = (data.get("metadata", {}) if isinstance(data, dict)
                else getattr(data, "metadata", {})) or {}

    # Locate the pack row.
    pack_row_id = metadata.get("pack_row_id") or ""
    pack_rows = []
    if pack_row_id:
        pack_rows = _supa_get("token_packs", {
            "id": f"eq.{pack_row_id}", "select": "*", "limit": "1",
        })
    if not pack_rows and session_id:
        pack_rows = _supa_get("token_packs", {
            "stripe_session_id": f"eq.{session_id}",
            "select": "*", "limit": "1",
        })
    if not pack_rows:
        log.warning("[billing] webhook: no token_pack found for session=%s pack_row_id=%s",
                    session_id, pack_row_id)
        return jsonify({"ok": True, "matched": False})

    pack = pack_rows[0]
    if pack.get("status") == "paid":
        return jsonify({"ok": True, "already_paid": True})

    # Mark paid + credit tokens.
    _supa_patch("token_packs", {"id": pack["id"]}, {
        "status":   "paid",
        "paid_at":  datetime.now(timezone.utc).isoformat(),
        "stripe_session_id": session_id or pack.get("stripe_session_id"),
    })
    org_id = pack.get("organization_id")
    tokens = int(pack.get("tokens") or 0)
    if org_id and tokens > 0:
        rows = _supa_get("organizations", {
            "id": f"eq.{org_id}", "select": "ai_tokens_balance", "limit": "1",
        })
        cur = int((rows[0].get("ai_tokens_balance") if rows else 0) or 0)
        _supa_patch("organizations", {"id": org_id},
                    {"ai_tokens_balance": cur + tokens})

    return jsonify({"ok": True, "matched": True, "tokens_credited": tokens})


@app.route("/funnel/billing/packs", methods=["GET", "OPTIONS"])
def funnel_billing_packs():
    """Static catalogue of token packs the Billing page renders. Lives
    on the server so price changes don't require a dashboard rebuild."""
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    return _cors(jsonify({
        "packs": [
            {"id": k, **v} for k, v in TOKEN_PACKS.items()
        ],
    }))


@app.route("/funnel/billing/plans", methods=["GET", "OPTIONS"])
def funnel_billing_plans():
    """Returns the 2 subscription tiers + 3 overage packs priced in the
    seller's local currency. The /billing dashboard page reads this on
    mount. Currency resolution:
      1. ?country_code= query param (manual override for testing)
      2. Organization.country_code (set during onboarding)
      3. First country in the seller's country_codes array
      4. Fallback 'MA' → MAD (the default test market)
    """
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    seller_id = _funnel_seller_id()
    org_id = _resolve_organization_id_for_seller(seller_id) if seller_id else None

    # Country override or auto-detect.
    country = (request.args.get("country_code") or "").strip().upper()
    if not country and org_id:
        try:
            org_rows = _supa_get("organizations", {
                "id": f"eq.{org_id}",
                "select": "country_code",
                "limit": "1",
            })
            if org_rows:
                country = (org_rows[0].get("country_code") or "").upper()
        except Exception:
            pass
    if not country and seller_id:
        try:
            seller_rows = _supa_get("sellers", {
                "id": f"eq.{seller_id}",
                "select": "country_codes",
                "limit": "1",
            })
            if seller_rows:
                ccs = seller_rows[0].get("country_codes") or []
                if ccs:
                    country = str(ccs[0]).upper()
        except Exception:
            pass
    if not country:
        country = "MA"

    currency = _resolve_currency_for_country(country)
    provider = _resolve_provider_for_country(country)

    # Tier cards.
    tiers_out = []
    for tier_id, cfg in PRICING_TIERS.items():
        amount = cfg["prices"].get(currency)
        if amount is None:
            # No pricing for this currency yet → fall back to USD.
            amount = cfg["prices"].get("USD")
            currency = "USD"
        tiers_out.append({
            "id":                tier_id,
            "label":             cfg.get("label") or tier_id.title(),
            "amount_minor":      amount,            # in currency's minor unit
            "currency":          currency,
            "sessions_included": cfg["sessions_included"],
            "monthly_tokens":    cfg["monthly_tokens"],  # internal — UI hides it
        })

    # Overage pack cards (same currency as tiers).
    packs_out = []
    for pack_id, cfg in TOKEN_PACK_PRICING.items():
        amount = cfg["prices"].get(currency) or cfg["prices"].get("USD")
        packs_out.append({
            "id":             pack_id,
            "label":          cfg["label"],
            "amount_minor":   amount,
            "currency":       currency,
            "tokens":         cfg["tokens"],
        })

    return _cors(jsonify({
        "country_code": country,
        "currency":     currency,
        "provider":     provider,
        "free_tier": {
            "sessions_included": FREE_TIER_SESSIONS,
            "monthly_tokens":    FREE_TIER_MONTHLY_TOKENS,
        },
        "tiers": tiers_out,
        "overage_packs": packs_out,
    }))


# ════════════════════════════════════════════════════════════════════════
# MANUAL PAYMENT FLOW (migration 0011)
# ════════════════════════════════════════════════════════════════════════
#
# Walking back from the Stripe/CinetPay auto-pay design — operator
# collects payments manually:
#   • Morocco → bank transfer (versement tijari) or CIH branch deposit
#   • WAEMU + Guinea + CEMAC → Orange Money / MTN MoMo / Wave
#
# Payment instructions live in system_settings.json under
# `payment_methods` so the admin can edit RIB / mobile-money numbers
# without a code deploy. Default fallbacks below let the bot work
# on first install.
DEFAULT_PAYMENT_METHODS: Dict[str, List[Dict[str, str]]] = {
    "MA": [
        {
            "method": "bank_transfer",
            "label": "Virement bancaire (Banque Populaire)",
            "details": "RIB : 011 780 00000XXXXXXXX 84\nIBAN : MA64 011 780 00000XXXXXXXX 84\nBénéficiaire : Konvico SARL",
            "instructions": "Effectuez le virement avec la référence ci-dessous en libellé.",
        },
        {
            "method": "cih_deposit",
            "label": "Versement CIH agence",
            "details": "Compte n° : 230 XXXXXXXXXXXXX\nBénéficiaire : Konvico SARL",
            "instructions": "Demandez le bordereau de versement à votre agence CIH.",
        },
    ],
    "SN": [
        {
            "method": "orange_money",
            "label": "Orange Money Sénégal",
            "details": "+221 77 XXX XX XX\nBénéficiaire : Konvico",
            "instructions": "Composez #144# puis Transfert → Saisir le numéro ci-dessus.",
        },
    ],
    "GN": [
        {
            "method": "orange_money",
            "label": "Orange Money Guinée",
            "details": "+224 6XX XX XX XX\nBénéficiaire : Konvico",
            "instructions": "Composez #144# puis Transfert → Saisir le numéro ci-dessus.",
        },
        {
            "method": "mtn_momo",
            "label": "MTN Mobile Money Guinée",
            "details": "+224 6XX XX XX XX\nBénéficiaire : Konvico",
            "instructions": "Composez *133# pour transférer.",
        },
    ],
    # Other WAEMU countries — same Orange Money pattern, per-country phone.
    "CI": [{"method":"orange_money","label":"Orange Money Côte d'Ivoire",
             "details":"+225 0X XX XX XX XX","instructions":"#144# pour transférer."}],
    "BJ": [{"method":"orange_money","label":"Orange Money Bénin",
             "details":"+229 9X XX XX XX","instructions":"#144# pour transférer."}],
    "TG": [{"method":"orange_money","label":"Orange Money Togo",
             "details":"+228 9X XX XX XX","instructions":"#144# pour transférer."}],
    "ML": [{"method":"orange_money","label":"Orange Money Mali",
             "details":"+223 7X XX XX XX","instructions":"#144# pour transférer."}],
    "BF": [{"method":"orange_money","label":"Orange Money Burkina",
             "details":"+226 7X XX XX XX","instructions":"#144# pour transférer."}],
    # CEMAC (XAF franc) — Orange Money + MTN MoMo predominant
    "CM": [{"method":"orange_money","label":"Orange Money Cameroun",
             "details":"+237 6XX XX XX XX","instructions":"#150# pour transférer."}],
    # International — bank transfer in USD/EUR
    "DEFAULT": [{"method":"bank_transfer","label":"International wire",
                  "details":"Contact billing@konvico.com for IBAN.",
                  "instructions":"Reference required on the wire."}],
}


def _resolve_payment_methods(country: str) -> List[Dict[str, str]]:
    """Look up the configured payment methods for a country. Reads
    system_settings.json `payment_methods.<COUNTRY>` first so the admin
    can override defaults via the System Settings page; falls back to
    DEFAULT_PAYMENT_METHODS otherwise."""
    cc = (country or "").upper()
    try:
        custom = _load_system_settings().get("payment_methods") or {}
        if cc in custom and isinstance(custom[cc], list):
            return custom[cc]
    except Exception:
        pass
    return DEFAULT_PAYMENT_METHODS.get(cc) or DEFAULT_PAYMENT_METHODS["DEFAULT"]


def _gen_payment_reference(org_id: str) -> str:
    """Short unique-ish code the customer cites when transferring. Lets
    the admin match a bank line / mobile-money notification back to a
    subscription request. Format: CDX-<6 hex chars from org_id>-<4 chars
    of utc timestamp>. Always uppercase + ASCII safe for SMS receipts."""
    org_part = (org_id or "").replace("-", "")[:6].upper()
    ts_part = f"{int(time.time()) % 10000:04d}"
    return f"CDX-{org_part}-{ts_part}"


# Fallback store for subscription requests when the billing schema (migration
# 0009/0010) isn't applied yet — so a seller can still subscribe + pay and the
# request isn't lost. Lives next to system_settings.json (git-ignored data/).
PENDING_SUBS_PATH = os.path.join(os.path.dirname(__file__), "data", "pending_subscriptions.json")


def _record_pending_subscription_fallback(req: Dict) -> None:
    """Append a subscription request to a local JSON file. Used only when
    the subscriptions table doesn't exist yet. Best-effort; never raises."""
    try:
        os.makedirs(os.path.dirname(PENDING_SUBS_PATH), exist_ok=True)
        existing: List[Dict] = []
        if os.path.exists(PENDING_SUBS_PATH):
            with open(PENDING_SUBS_PATH, "r", encoding="utf-8") as f:
                loaded = json.load(f)
                if isinstance(loaded, list):
                    existing = loaded
        existing.append(req)
        tmp = PENDING_SUBS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(existing, f, ensure_ascii=False, indent=2)
        os.replace(tmp, PENDING_SUBS_PATH)
        log.info("[subscribe] pending subscription recorded to fallback file: "
                 "seller=%s tier=%s ref=%s",
                 req.get("seller_id"), req.get("tier"), req.get("payment_reference"))
    except Exception as exc:
        log.warning("[subscribe] fallback record failed: %s", exc)


@app.route("/funnel/billing/payment-instructions", methods=["GET", "OPTIONS"])
def funnel_billing_payment_instructions():
    """Returns the per-country payment instructions for the Billing
    page modal. Resolves country from query param or from the seller's
    organization.country_code."""
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    country = (request.args.get("country_code") or "").strip().upper()
    if not country:
        seller_id = _funnel_seller_id()
        org_id = _resolve_organization_id_for_seller(seller_id) if seller_id else None
        if org_id:
            try:
                rows = _supa_get("organizations", {
                    "id": f"eq.{org_id}",
                    "select": "country_code",
                    "limit": "1",
                })
                if rows:
                    country = (rows[0].get("country_code") or "").upper()
            except Exception:
                pass
        country = country or "MA"
    return _cors(jsonify({
        "country_code": country,
        "methods": _resolve_payment_methods(country),
    }))


@app.route("/funnel/billing/subscribe", methods=["POST", "OPTIONS"])
def funnel_billing_subscribe():
    """Submit a subscription REQUEST for admin review.

    Body: { tier: 'starter'|'pro', months?: 1..12, payment_method?,
            payment_proof_url? }

    Creates a `subscriptions` row with status='pending_admin_review' +
    a payment_reference the customer cites when transferring. Admin
    later activates via /funnel/admin/subscriptions/:id/activate.

    Returns the request + the country-specific payment instructions
    the dashboard renders in the post-submit confirmation modal.
    """
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    if not _funnel_only_localhost():
        return _cors(jsonify({"error": "forbidden"})), 403

    seller_id = _funnel_seller_id()
    if not seller_id:
        return _cors(jsonify({"error": "no seller resolved"})), 400
    # Ensure an organization exists so the pending request lands in the
    # subscriptions table (admin can then activate it). New signups have no
    # org until now; this lazily creates one. Still None pre-migration 0009.
    org_id = _ensure_organization_for_seller(seller_id)

    body = request.get_json(silent=True) or {}
    tier = (body.get("tier") or "").strip().lower()
    if tier not in PRICING_TIERS:
        return _cors(jsonify({
            "error": "unknown_tier",
            "available": list(PRICING_TIERS.keys()),
        })), 400

    # Months requested (1-12). Defaults to 1 = month-to-month.
    try:
        months = int(body.get("months") or 1)
    except (TypeError, ValueError):
        months = 1
    months = max(1, min(12, months))

    payment_method = (body.get("payment_method") or "").strip().lower() or None
    proof_url = (body.get("payment_proof_url") or "").strip() or None

    # Country: explicit override → org country (if migrated) → default MA.
    country = (body.get("country_code") or "").strip().upper()
    if not country and org_id:
        try:
            rows = _supa_get("organizations", {
                "id": f"eq.{org_id}",
                "select": "country_code",
                "limit": "1",
            })
            if rows:
                country = (rows[0].get("country_code") or "").upper()
        except Exception:
            pass
    if not country:
        country = "MA"
    currency = _resolve_currency_for_country(country)

    cfg = PRICING_TIERS[tier]
    per_month_minor = cfg["prices"].get(currency) or cfg["prices"]["USD"]
    total_minor = per_month_minor * months

    from datetime import datetime as _dt, timezone as _tz, timedelta as _td
    placeholder_end = (_dt.now(_tz.utc) + _td(days=30 * months)).isoformat()
    reference = _gen_payment_reference(org_id or seller_id)

    if org_id:
        # Billing schema present → persist country + create the review-queue row.
        try:
            _supa_patch("organizations", {"id": org_id}, {"country_code": country})
        except Exception:
            pass
        inserted = _supa_post("subscriptions", {
            "organization_id":  org_id,
            "tier":             tier,
            "status":           "pending_admin_review",
            "provider":         "manual",
            "amount_cents":     total_minor,
            "currency":         currency,
            "current_period_end": placeholder_end,
            "months_paid_for":  months,
            "payment_method":   payment_method,
            "payment_proof_url": proof_url,
            "payment_reference": reference,
        })
        if not inserted:
            return _cors(jsonify({"error": "could_not_create_subscription"})), 500
        sub_row_id = inserted.get("id")
    else:
        # Billing migration (0009/0010) not applied yet → DON'T 503. Record the
        # request to the local fallback file so it isn't lost, and still return
        # the payment instructions so the seller can pay right away. The admin
        # reconciles from data/pending_subscriptions.json until the
        # subscriptions table exists (then the path above takes over).
        _record_pending_subscription_fallback({
            "seller_id":         seller_id,
            "tier":              tier,
            "months":            months,
            "amount_cents":      total_minor,
            "currency":          currency,
            "country_code":      country,
            "payment_method":    payment_method,
            "payment_reference": reference,
            "requested_at":      _dt.now(_tz.utc).isoformat(),
        })
        sub_row_id = reference

    return _cors(jsonify({
        "ok": True,
        "request_id":   sub_row_id,
        "status":       "pending_admin_review",
        "tier":         tier,
        "months":       months,
        "per_month_minor": per_month_minor,
        "total_minor":  total_minor,
        "currency":     currency,
        "country_code": country,
        "payment_reference": reference,
        "payment_methods": _resolve_payment_methods(country),
        "message": (
            "Effectuez le virement vers l'un des moyens ci-dessous, puis "
            "envoyez cette référence + une capture d'écran du reçu par "
            "WhatsApp. Votre abonnement sera activé dès la vérification du "
            "paiement. (Pas besoin de l'écrire dans le motif du virement.)"
        ),
    }))


# ════════════════════════════════════════════════════════════════════════
# ADMIN — manual subscription review queue
# ════════════════════════════════════════════════════════════════════════

@app.route("/funnel/admin/subscriptions", methods=["GET", "OPTIONS"])
def funnel_admin_subscriptions():
    """Admin endpoint: list subscription requests. By default returns
    only pending_admin_review; pass ?status=all to see history.

    Auth: header `X-Admin-User-Id` (set by the dashboard's admin role
    layer) must match an app_users row with role='admin'. Falls back
    to the same localhost-only gate the other admin endpoints use.
    """
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    if not _require_admin():
        return _cors(jsonify({"error": "forbidden"})), 403

    status_filter = (request.args.get("status") or "pending_admin_review").lower()
    params = {
        "select": "*,organizations(id,name,country_code,owner_user_id)",
        "order": "created_at.desc",
        "limit": "200",
    }
    if status_filter and status_filter != "all":
        params["status"] = f"eq.{status_filter}"
    try:
        rows = _supa_get("subscriptions", params)
    except Exception as exc:
        log.warning("[admin] subscriptions list failed: %s", exc)
        rows = []
    return _cors(jsonify({"subscriptions": rows}))


@app.route("/funnel/admin/subscriptions/<sub_id>/activate", methods=["POST", "OPTIONS"])
def funnel_admin_subscription_activate(sub_id: str):
    """Admin marks a pending request as paid + active for N months.

    Body: { months_granted?: int, admin_notes?: string }

    Activates the row, sets current_period_end to now + N·30 days,
    refills the org's ai_tokens_balance to monthly_token_grant × N
    (one big grant covering the multi-month period — no daily cron
    needed for the lifetime of this subscription).

    Also flips any OTHER active subscription on the same org to
    'cancelled' so the unique-active-per-org constraint stays valid.
    """
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    if not _require_admin():
        return _cors(jsonify({"error": "forbidden"})), 403

    body = request.get_json(silent=True) or {}
    sub_rows = _supa_get("subscriptions", {
        "id": f"eq.{sub_id}",
        "select": "*",
        "limit": "1",
    })
    if not sub_rows:
        return _cors(jsonify({"error": "subscription_not_found"})), 404
    sub = sub_rows[0]

    if sub.get("status") not in ("pending_admin_review", "past_due"):
        return _cors(jsonify({
            "error": "wrong_status",
            "current_status": sub.get("status"),
            "expected": "pending_admin_review or past_due",
        })), 409

    months_granted = body.get("months_granted")
    if months_granted is None:
        months_granted = sub.get("months_paid_for") or 1
    try:
        months_granted = max(1, min(24, int(months_granted)))
    except (TypeError, ValueError):
        months_granted = 1

    admin_notes = (body.get("admin_notes") or "").strip() or None
    admin_user_id = (request.headers.get("X-Admin-User-Id") or "").strip() or None

    from datetime import datetime as _dt, timezone as _tz, timedelta as _td
    now = _dt.now(_tz.utc)
    period_end = (now + _td(days=30 * months_granted)).isoformat()

    # Cancel any other active sub on the same org so the unique-active
    # constraint accepts the new one.
    org_id = sub.get("organization_id")
    try:
        active_rows = _supa_get("subscriptions", {
            "organization_id": f"eq.{org_id}",
            "status": "eq.active",
            "select": "id",
        })
        for r in active_rows:
            if r["id"] != sub_id:
                _supa_patch("subscriptions", {"id": r["id"]}, {
                    "status": "cancelled",
                    "cancelled_at": now.isoformat(),
                })
    except Exception:
        pass

    # Activate this row.
    _supa_patch("subscriptions", {"id": sub_id}, {
        "status":               "active",
        "current_period_end":   period_end,
        "months_paid_for":      months_granted,
        "activated_at":         now.isoformat(),
        "activated_by_user_id": admin_user_id,
        "admin_notes":          admin_notes,
    })

    # Refill the org's monthly grant × months_granted. One big bucket
    # for the whole period instead of a daily reset cron — keeps the
    # ops simple.
    tier_cfg = PRICING_TIERS.get(sub.get("tier") or "starter", {})
    monthly_grant = tier_cfg.get("monthly_tokens", FREE_TIER_MONTHLY_TOKENS)
    total_grant = monthly_grant * months_granted
    _supa_patch("organizations", {"id": org_id}, {
        "plan":                sub.get("tier"),
        "ai_tokens_balance":   total_grant,
        "monthly_token_grant": monthly_grant,
        "period_starts_at":    now.isoformat(),
        "period_ends_at":      period_end,
    })

    # Clear the trial flag on the org's seller(s) so the dashboard trial
    # banner disappears AND the access gate treats them as a paid account.
    try:
        _supa_patch("sellers", {"organization_id": org_id}, {"is_trial": False})
    except Exception:
        pass

    log.info("[admin] activated sub %s for org %s: tier=%s months=%d grant=%d",
             sub_id, org_id, sub.get("tier"), months_granted, total_grant)
    return _cors(jsonify({
        "ok":                  True,
        "subscription_id":     sub_id,
        "months_granted":      months_granted,
        "tokens_granted_total": total_grant,
        "period_ends_at":      period_end,
    }))


@app.route("/funnel/admin/subscriptions/<sub_id>/reject", methods=["POST", "OPTIONS"])
def funnel_admin_subscription_reject(sub_id: str):
    """Admin rejects a pending request — e.g. payment never arrived,
    wrong reference, fraud signal.

    Body: { rejection_reason?: string, admin_notes?: string }
    """
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    if not _require_admin():
        return _cors(jsonify({"error": "forbidden"})), 403

    body = request.get_json(silent=True) or {}
    reason = (body.get("rejection_reason") or "").strip() or "no reason given"
    notes = (body.get("admin_notes") or "").strip() or None

    from datetime import datetime as _dt, timezone as _tz
    ok = _supa_patch("subscriptions", {"id": sub_id}, {
        "status":           "rejected",
        "rejected_at":      _dt.now(_tz.utc).isoformat(),
        "rejection_reason": reason,
        "admin_notes":      notes,
    })
    if not ok:
        return _cors(jsonify({"error": "patch_failed"})), 500
    return _cors(jsonify({"ok": True, "subscription_id": sub_id}))


@app.route("/funnel/stats/dashboard", methods=["GET", "OPTIONS"])
def funnel_stats_dashboard():
    """Real numbers for the top-of-dashboard stat cards.

    Returns a small JSON with keys the React Dashboard consumes:
      • messages_today  → count of rows in `messages` (user + assistant)
                          whose conversation belongs to the seller AND
                          whose created_at is today UTC.
      • api_calls_24h   → count of rows in the same table over the last
                          24 hours. This is a meaningful proxy for the
                          seller's API traffic (each customer message =
                          one inbound webhook + at minimum one outbound
                          send-text = activity volume).
      • orders_today    → bonus: how many completed orders today.
      • conversations_active → conversations.status='active' count.

    The old hardcoded "—" placeholders in Dashboard.tsx were a TODO the
    operator finally noticed. This endpoint replaces them with live
    Supabase-scoped counts so the dashboard reflects reality.
    """
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    seller_id = _funnel_seller_id()
    if not seller_id:
        return _cors(jsonify({"error": "no seller resolved"})), 400

    # Compute today (UTC). Supabase REST has no aggregate count helper,
    # but PostgREST returns the row count in the Content-Range header
    # when we use `Prefer: count=exact`. We exploit that by HEAD-ing
    # the row, but httpx GET works too — we just discard the body and
    # parse the count header. To keep things simple here, we GET the
    # ids with limit=1 + count header.
    from datetime import datetime as _dt, timezone as _tz, timedelta as _td
    now = _dt.now(_tz.utc)
    today_iso = now.replace(hour=0, minute=0, second=0,
                            microsecond=0).isoformat()
    h24_iso = (now - _td(hours=24)).isoformat()

    def _count(table: str, filters: Dict[str, str]) -> int:
        """Use PostgREST count=exact pattern to ask "how many rows match
        these filters?" without pulling the rows themselves."""
        params = {"select": "id", "limit": "1", **filters}
        headers = {**_supa_headers(), "Prefer": "count=exact"}
        try:
            r = httpx.get(
                f"{SUPABASE_URL}/rest/v1/{table}",
                params=params, headers=headers,
                timeout=8.0, verify=_SUPA_VERIFY,
            )
            rng = r.headers.get("content-range") or ""
            # Format is "0-0/<total>" or "*/0" when empty.
            if "/" in rng:
                total = rng.split("/", 1)[1]
                if total.isdigit():
                    return int(total)
        except Exception as exc:
            log.warning("[stats] count %s failed: %s", table, exc)
        return 0

    d30_iso = (now - _td(days=30)).isoformat()
    series_days = 14

    # Find conversations owned by this seller. id → drives the message
    # counts below; status → active count + resolution rate; started_at →
    # the new-contacts time series. PostgREST caps this at 1000 rows; the
    # series window only needs the recent slice, and exact lifetime totals
    # come from _count (which never pulls rows).
    convo_rows = _supa_get("customer_conversations", {
        "seller_id": f"eq.{seller_id}",
        "select": "id,status,started_at",
        "order": "started_at.desc",
    })
    convo_ids = [c["id"] for c in convo_rows]
    active_convos = sum(1 for c in convo_rows if c.get("status") == "active")
    order_placed = sum(1 for c in convo_rows if c.get("status") == "order_placed")

    # Exact lifetime headline totals (count=exact header, no row payload).
    conversations_total = _count("customer_conversations", {
        "seller_id": f"eq.{seller_id}",
    })
    conversions_total = _count("orders", {
        "seller_id": f"eq.{seller_id}",
    })

    # Resolution rate = share of conversations that ended in an order.
    # Numerator + denominator both from the fetched sample so they stay
    # consistent; for <1000 conversations it equals the exact figure.
    resolution_rate = round(order_placed / len(convo_rows), 4) if convo_rows else 0.0

    # Message counts over the seller's conversations. PostgREST can't join
    # in a count, so we filter messages by conversation_id IN (...).
    if convo_ids:
        in_filter = "in.(" + ",".join(convo_ids) + ")"
        messages_today = _count("messages", {
            "conversation_id": in_filter,
            "created_at": f"gte.{today_iso}",
        })
        api_calls_24h = _count("messages", {
            "conversation_id": in_filter,
            "created_at": f"gte.{h24_iso}",
        })
        messages_sent = _count("messages", {
            "conversation_id": in_filter,
            "role": "eq.assistant",
            "created_at": f"gte.{d30_iso}",
        })
        messages_received = _count("messages", {
            "conversation_id": in_filter,
            "role": "eq.user",
            "created_at": f"gte.{d30_iso}",
        })
    else:
        messages_today = api_calls_24h = messages_sent = messages_received = 0

    # Bot response rate = replies ÷ inbound, capped at 100%. A healthy bot
    # sits near 1.0; a dip flags dropped or unanswered messages.
    response_rate = (
        round(min(1.0, messages_sent / messages_received), 4)
        if messages_received else 0.0
    )

    # Recent orders (≤1000) drive BOTH the channel donut (grouped by source)
    # and the orders time series (only rows inside the 14-day window land in
    # the daily buckets below).
    order_rows = _supa_get("orders", {
        "seller_id": f"eq.{seller_id}",
        "select": "created_at,source",
        "order": "created_at.desc",
        "limit": "1000",
    })
    # Channel split — the honest "where did orders come from" breakdown: the
    # bot (whatsapp) vs imported Shopify orders. Legacy rows written before
    # the `source` column default to whatsapp.
    channels: Dict[str, int] = {}
    for o in order_rows:
        src = (o.get("source") or "whatsapp").strip() or "whatsapp"
        channels[src] = channels.get(src, 0) + 1

    from collections import defaultdict as _dd
    conv_by_day: Dict[str, int] = _dd(int)
    for c in convo_rows:
        day = (c.get("started_at") or "")[:10]
        if day:
            conv_by_day[day] += 1
    ord_by_day: Dict[str, int] = _dd(int)
    for o in order_rows:
        day = (o.get("created_at") or "")[:10]
        if day:
            ord_by_day[day] += 1

    series = []
    for i in range(series_days - 1, -1, -1):
        day = (now - _td(days=i)).strftime("%Y-%m-%d")
        series.append({
            "date": day,
            "conversations": conv_by_day.get(day, 0),
            "orders": ord_by_day.get(day, 0),
        })

    today_str = now.strftime("%Y-%m-%d")
    orders_today = ord_by_day.get(today_str, 0)

    last7, prev7 = series[-7:], series[-14:-7]
    new_contacts_7d = sum(s["conversations"] for s in last7)
    new_contacts_prev_7d = sum(s["conversations"] for s in prev7)
    conversions_7d = sum(s["orders"] for s in last7)
    conversions_prev_7d = sum(s["orders"] for s in prev7)

    return _cors(jsonify({
        # ── existing keys (kept for backward compatibility) ──
        "messages_today": messages_today,
        "api_calls_24h": api_calls_24h,
        "orders_today": orders_today,
        "conversations_active": active_convos,
        # ── KPI headline numbers ──
        "conversations_total": conversations_total,
        "new_contacts_7d": new_contacts_7d,
        "new_contacts_prev_7d": new_contacts_prev_7d,
        "resolution_rate": resolution_rate,
        "order_placed_total": order_placed,
        "conversations_sampled": len(convo_rows),
        "conversions_total": conversions_total,
        "conversions_7d": conversions_7d,
        "conversions_prev_7d": conversions_prev_7d,
        # ── channels donut ──
        "channels": channels,
        # ── bot performance (last 30 days) ──
        "messages_sent": messages_sent,
        "messages_received": messages_received,
        "response_rate": response_rate,
        # ── time series (last 14 days) ──
        "series": series,
    }))


# ════════════════════════════════════════════════════════════════════════
# SHOPIFY INTEGRATION — auto-import orders from a seller's Shopify store
#
# Connect method: Custom App + token. The seller creates a Custom App in
# their Shopify admin (read_orders scope), then pastes shop_domain +
# Admin API access_token + api_secret into the dashboard. We verify the
# credentials, register an orders/create webhook pointing back at
# ${PUBLIC_BASE_URL}/funnel/integrations/shopify/webhook, and authenticate
# every delivery with HMAC-SHA256 against the stored api_secret. A valid
# order imports as a Konvico `orders` row with status='pending' (+ Sheets
# push) — NO automatic WhatsApp message is sent.
# ════════════════════════════════════════════════════════════════════════

def _shopify_normalize_domain(raw: str) -> str:
    """Reduce whatever the seller pasted to a bare host, lowercased.
    Accepts 'https://my-store.myshopify.com/admin', 'my-store.myshopify.com/',
    etc. → 'my-store.myshopify.com'."""
    d = (raw or "").strip().lower()
    if not d:
        return ""
    d = re.sub(r"^https?://", "", d)
    d = d.split("/", 1)[0].strip()
    return d


def _shopify_webhook_address() -> str:
    """The public URL Shopify must POST order webhooks to."""
    if not PUBLIC_BASE_URL:
        return ""
    return f"{PUBLIC_BASE_URL}/funnel/integrations/shopify/webhook"


def _shopify_public_url_ok() -> bool:
    """Shopify only accepts a public https webhook address. In local dev
    PUBLIC_BASE_URL is empty or localhost, so we defer auto-registration
    (the connect endpoint still stores the credentials)."""
    u = PUBLIC_BASE_URL
    if not u or not u.startswith("https://"):
        return False
    host = u[len("https://"):].split("/", 1)[0].lower()
    if host in ("localhost", "127.0.0.1", "::1") or host.startswith("127.") or "localhost" in host:
        return False
    return True


def _shopify_admin_request(shop_domain: str, access_token: str, method: str,
                           path: str, json_body: Optional[Dict] = None,
                           params: Optional[Dict] = None, timeout: float = 20):
    """Call the Shopify Admin REST API. Returns (status_code, parsed_body).
    status_code 0 signals a transport-level failure."""
    url = f"https://{shop_domain}/admin/api/{SHOPIFY_API_VERSION}/{path.lstrip('/')}"
    headers = {
        "X-Shopify-Access-Token": access_token,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    try:
        r = httpx.request(method, url, headers=headers, json=json_body,
                          params=params, timeout=timeout, verify=_SUPA_VERIFY)
        try:
            body = r.json()
        except Exception:
            body = r.text
        return r.status_code, body
    except Exception as exc:
        log.warning("[shopify] admin %s %s failed: %s", method, path, exc)
        return 0, {"error": str(exc)}


def _shopify_register_webhook(shop_domain: str, access_token: str):
    """Ensure an orders/create webhook exists pointing at our address.
    Returns (webhook_id, error). Reuses an existing matching webhook so
    reconnecting doesn't pile up duplicates."""
    if not _shopify_public_url_ok():
        return None, "public_url_unset"
    address = _shopify_webhook_address()
    status, body = _shopify_admin_request(
        shop_domain, access_token, "GET", "webhooks.json",
        params={"topic": "orders/create", "limit": 250})
    if status == 200 and isinstance(body, dict):
        for wh in (body.get("webhooks") or []):
            if (wh.get("address") or "") == address:
                return str(wh.get("id")), None
    status, body = _shopify_admin_request(
        shop_domain, access_token, "POST", "webhooks.json",
        json_body={"webhook": {"topic": "orders/create",
                               "address": address, "format": "json"}})
    if status in (200, 201) and isinstance(body, dict):
        wh = body.get("webhook") or {}
        if wh.get("id"):
            return str(wh["id"]), None
    return None, f"register_failed_http_{status}"


def _shopify_delete_webhook(shop_domain: str, access_token: str, webhook_id: str) -> bool:
    """Remove a registered webhook. 404 (already gone) counts as success."""
    if not webhook_id:
        return True
    status, _ = _shopify_admin_request(
        shop_domain, access_token, "DELETE", f"webhooks/{webhook_id}.json")
    return status in (200, 204, 404)


def _shopify_verify_hmac(secret: str, raw_body: bytes, hmac_header: str) -> bool:
    """Constant-time compare of Shopify's X-Shopify-Hmac-Sha256 (base64
    HMAC-SHA256 of the raw request body, keyed by the app's API secret)."""
    if not (secret and hmac_header):
        return False
    digest = hmac.new(secret.encode("utf-8"), raw_body or b"", hashlib.sha256).digest()
    computed = base64.b64encode(digest).decode("utf-8")
    try:
        return hmac.compare_digest(computed, hmac_header)
    except Exception:
        return False


def _shopify_integration_for_seller(seller_id: str) -> Optional[Dict]:
    rows = _supa_get("shopify_integrations", {
        "seller_id": f"eq.{seller_id}", "select": "*", "limit": "1",
    })
    return rows[0] if rows else None


def _shopify_integration_for_domain(domain: str) -> Optional[Dict]:
    rows = _supa_get("shopify_integrations", {
        "shop_domain": f"eq.{(domain or '').lower()}", "select": "*", "limit": "1",
    })
    return rows[0] if rows else None


def _shopify_public_view(integ: Optional[Dict]) -> Dict:
    """Dashboard-safe projection — secrets are masked to their last 4 chars
    so the seller can confirm WHICH token they pasted without exposing it."""
    if not integ:
        return {"connected": False}

    def _tail(s: Optional[str]) -> str:
        s = s or ""
        return ("…" + s[-4:]) if len(s) >= 4 else "••••"

    return {
        "connected": integ.get("status") == "connected",
        "status": integ.get("status"),
        "shop_domain": integ.get("shop_domain"),
        "access_token_hint": _tail(integ.get("access_token")),
        "api_secret_hint": _tail(integ.get("api_secret")),
        "webhook_registered": bool(integ.get("webhook_id")),
        "webhook_api_version": integ.get("webhook_api_version"),
        "last_order_at": integ.get("last_order_at"),
        "last_error": integ.get("last_error"),
        "created_at": integ.get("created_at"),
        "updated_at": integ.get("updated_at"),
    }


def _shopify_phone_to_jid(phone: str) -> str:
    """Synthesize a WhatsApp JID from a phone number so the imported order
    satisfies orders.customer_jid (NOT NULL) and lines up with any future
    WhatsApp conversation from the same number."""
    digits = re.sub(r"\D", "", phone or "")
    return f"{digits}@s.whatsapp.net" if digits else ""


def _shopify_match_or_create_product(seller_id: str, line_item: Dict,
                                     currency: str, country_code: str) -> Optional[str]:
    """Resolve a Konvico product id for a Shopify line item. Order of
    preference: existing product by Shopify product id → by name → create a
    new one (+ a product_countries price row so it renders in the catalog).
    orders.product_id is NOT NULL, so this must always return an id or the
    import aborts."""
    shopify_pid = str(line_item.get("product_id") or "").strip()
    title = (line_item.get("title") or line_item.get("name") or "").strip() or "Produit Shopify"

    if shopify_pid:
        rows = _supa_get("products", {
            "seller_id": f"eq.{seller_id}",
            "shopify_product_id": f"eq.{shopify_pid}",
            "select": "id", "limit": "1",
        })
        if rows:
            return rows[0]["id"]

    # Match an existing Konvico product by case-insensitive exact name.
    rows = _supa_get("products", {
        "seller_id": f"eq.{seller_id}",
        "name": f"ilike.{title}",
        "select": "id", "limit": "1",
    })
    if rows:
        if shopify_pid:
            _supa_patch("products", {"id": rows[0]["id"]},
                        {"shopify_product_id": shopify_pid})
        return rows[0]["id"]

    # Create a fresh product.
    new_prod = _supa_post("products", {
        "seller_id": seller_id,
        "name": title,
        "status": "active",
        "shopify_product_id": shopify_pid or None,
    })
    if not new_prod:
        return None
    pid = new_prod["id"]
    try:
        price = float(line_item.get("price") or 0)
    except Exception:
        price = 0.0
    if country_code and currency:
        # Best effort — the order inserts fine without it; this just makes
        # the auto-created product show a price in the dashboard catalog.
        _supa_post("product_countries", {
            "product_id": pid,
            "country_code": country_code,
            "language_code": "fr",
            "price": price,
            "currency": currency,
            "available": True,
        })
    return pid


def _shopify_import_order(seller: Dict, integration: Dict, payload: Dict):
    """Map a Shopify orders/create payload onto a Konvico orders row.
    Idempotent on (seller_id, shopify_order_id). Returns (result, info) where
    result ∈ {'ok','duplicate','bad','error'}."""
    seller_id = seller["id"]
    shopify_order_id = str(payload.get("id") or "").strip()
    if not shopify_order_id:
        return "bad", {"error": "missing order id"}

    # Idempotency: Shopify retries deliveries, so skip an already-imported
    # order (the unique partial index is the hard backstop).
    existing = _supa_get("orders", {
        "seller_id": f"eq.{seller_id}",
        "shopify_order_id": f"eq.{shopify_order_id}",
        "select": "id", "limit": "1",
    })
    if existing:
        return "duplicate", {"order_id": existing[0]["id"]}

    line_items = payload.get("line_items") or []
    primary = line_items[0] if line_items else {}

    ship = payload.get("shipping_address") or payload.get("billing_address") or {}
    customer = payload.get("customer") or {}
    cust_name = (
        (ship.get("name") or "").strip()
        or f"{customer.get('first_name', '')} {customer.get('last_name', '')}".strip()
        or (payload.get("email") or "").strip()
        or "Client Shopify"
    )
    phone = (payload.get("phone") or ship.get("phone")
             or customer.get("phone") or "").strip()
    jid = _shopify_phone_to_jid(phone) or f"shopify_{shopify_order_id}@import.konvico"
    address = (ship.get("address1") or "").strip()
    if ship.get("address2"):
        address = f"{address} {ship['address2']}".strip()
    city = (ship.get("city") or "").strip()
    country_code = (ship.get("country_code") or "").upper()
    currency = (payload.get("currency") or "").upper()

    qty = int(primary.get("quantity") or 1)
    if qty <= 0:
        qty = 1
    try:
        unit_price = float(primary.get("price") or 0)
    except Exception:
        unit_price = 0.0
    try:
        total_price = float(payload.get("total_price") or 0) or (unit_price * qty)
    except Exception:
        total_price = unit_price * qty

    product_id = _shopify_match_or_create_product(seller_id, primary, currency, country_code)
    if not product_id:
        return "error", {"error": "product mapping failed"}

    order_number = payload.get("name") or f"#{payload.get('order_number') or shopify_order_id}"
    items_txt = "; ".join(
        f"{(li.get('title') or li.get('name') or 'article')} x{li.get('quantity') or 1}"
        for li in line_items
    ) or "—"
    notes = f"Shopify {order_number} · {items_txt}"
    fin_status = payload.get("financial_status") or ""
    if fin_status:
        notes += f" · paiement: {fin_status}"

    order_row = {
        "seller_id": seller_id,
        "product_id": product_id,
        "customer_jid": jid,
        "customer_name": cust_name,
        "customer_phone": phone,
        "customer_address": address,
        "customer_city": city,
        "quantity": qty,
        "unit_price": unit_price,
        "total_price": total_price,
        "currency": currency or "USD",
        "country_code": country_code or None,
        "status": "pending",
        "source": "shopify",
        "shopify_order_id": shopify_order_id,
        "sheets_sync_status": "pending",
    }
    inserted = _supa_post("orders", order_row)
    if not inserted:
        # Most likely the unique index caught a race with a concurrent
        # re-delivery — treat as duplicate, not a hard error.
        again = _supa_get("orders", {
            "seller_id": f"eq.{seller_id}",
            "shopify_order_id": f"eq.{shopify_order_id}",
            "select": "id", "limit": "1",
        })
        if again:
            return "duplicate", {"order_id": again[0]["id"]}
        return "error", {"error": "insert failed"}

    # Push to the seller's Google Sheet, reusing the WhatsApp-order shape so
    # an existing Apps Script picks the row up with no changes.
    prows = _supa_get("products", {
        "id": f"eq.{product_id}",
        "select": "id,name,sheets_webhook_url", "limit": "1",
    })
    product_row = prows[0] if prows else None
    address_combined = (address + (", " + city if city else "")).strip(", ").strip()
    sheet_payload = {
        "sku": "",
        "Customer_Name": cust_name,
        "Phone": phone,
        "address": address_combined,
        "Quantity": qty,
        "total_price": total_price,
        "id": inserted.get("id"),
        "currency": currency,
        "country_code": country_code,
        "customer_jid": jid,
        "created_at": inserted.get("created_at"),
        "source": "shopify",
        "item_name": (product_row or {}).get("name") or (primary.get("title") or ""),
        "localized_details": notes,
    }
    pushed = push_order_to_sheet(seller, product_row, sheet_payload)
    if pushed:
        _supa_patch("orders", {"id": inserted["id"]}, {
            "sheets_sync_status": "synced",
            "sheets_sync_at": datetime.now(timezone.utc).isoformat(),
        })
    else:
        _supa_patch("orders", {"id": inserted["id"]}, {"sheets_sync_status": "failed"})

    _supa_patch("shopify_integrations", {"id": integration["id"]}, {
        "last_order_at": datetime.now(timezone.utc).isoformat(),
        "last_error": None,
        "status": "connected",
    })
    return "ok", {"order_id": inserted["id"], "shopify_order_id": shopify_order_id}


@app.route("/funnel/integrations/shopify", methods=["GET", "OPTIONS"])
def funnel_integrations_shopify_get():
    """Masked Shopify connection status for the dashboard Integrations page."""
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    seller_id = _funnel_seller_id()
    if not seller_id:
        return _cors(jsonify({"error": "seller not resolved"})), 400
    integ = _shopify_integration_for_seller(seller_id)
    return _cors(jsonify({
        "integration": _shopify_public_view(integ),
        "public_url_configured": _shopify_public_url_ok(),
        "webhook_url": _shopify_webhook_address(),
        "api_version": SHOPIFY_API_VERSION,
    }))


@app.route("/funnel/integrations/shopify/connect", methods=["POST", "OPTIONS"])
def funnel_integrations_shopify_connect():
    """Verify the Custom App credentials, register the orders/create webhook,
    and upsert the integration row. Body: { shop_domain, access_token,
    api_secret }."""
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    seller_id = _funnel_seller_id()
    if not seller_id:
        return _cors(jsonify({"error": "seller not resolved"})), 400
    seller = fetch_seller(seller_id)
    if not seller:
        return _cors(jsonify({"error": "seller not found"})), 404

    body = request.get_json(silent=True) or {}
    shop_domain = _shopify_normalize_domain(body.get("shop_domain") or "")
    access_token = (body.get("access_token") or "").strip()
    api_secret = (body.get("api_secret") or "").strip()
    if not (shop_domain and access_token and api_secret):
        return _cors(jsonify({"error": "shop_domain, access_token et api_secret sont requis"})), 400
    if not shop_domain.endswith(".myshopify.com"):
        return _cors(jsonify({"error": "Le domaine doit être au format votre-boutique.myshopify.com"})), 400

    # Another seller already owns this store?
    dom_owner = _shopify_integration_for_domain(shop_domain)
    if dom_owner and dom_owner.get("seller_id") != seller_id:
        return _cors(jsonify({"error": "Cette boutique Shopify est déjà connectée à un autre compte Konvico."})), 409

    # 1. Verify the credentials by reading the shop record.
    status, shop_body = _shopify_admin_request(shop_domain, access_token, "GET", "shop.json")
    if status in (401, 403):
        return _cors(jsonify({"error": "Token d'accès invalide ou permission read_orders manquante."})), 400
    if status != 200 or not isinstance(shop_body, dict) or "shop" not in shop_body:
        return _cors(jsonify({"error": f"Connexion à Shopify échouée (HTTP {status}). Vérifiez le domaine et le token."})), 400

    # 2. Register the orders/create webhook (deferred in dev — see helper).
    webhook_id, wh_err = _shopify_register_webhook(shop_domain, access_token)

    # 3. Upsert the integration row.
    existing = _shopify_integration_for_seller(seller_id)
    row = {
        "seller_id": seller_id,
        "shop_domain": shop_domain,
        "access_token": access_token,
        "api_secret": api_secret,
        "webhook_id": webhook_id,
        "webhook_api_version": SHOPIFY_API_VERSION,
        "status": "connected",
        "last_error": None if not wh_err else f"webhook: {wh_err}",
    }
    if existing:
        # Domain changed → tidy up the old store's webhook first.
        if existing.get("webhook_id") and existing.get("shop_domain") != shop_domain:
            _shopify_delete_webhook(existing["shop_domain"], existing["access_token"],
                                    existing["webhook_id"])
        _supa_patch("shopify_integrations", {"id": existing["id"]}, row)
    else:
        _supa_post("shopify_integrations", row)
    saved = _shopify_integration_for_seller(seller_id)

    shop_name = (shop_body.get("shop") or {}).get("name") or shop_domain
    return _cors(jsonify({
        "ok": True,
        "shop_name": shop_name,
        "integration": _shopify_public_view(saved),
        "webhook_registered": bool(webhook_id),
        "webhook_url": _shopify_webhook_address(),
        "webhook_warning": (None if webhook_id else
            "Identifiants enregistrés, mais le webhook n'a pas pu être créé automatiquement "
            "(PUBLIC_BASE_URL doit être une URL https publique). Configurez un tunnel public "
            "puis reconnectez pour activer l'import automatique."),
    }))


@app.route("/funnel/integrations/shopify/disconnect", methods=["POST", "OPTIONS"])
def funnel_integrations_shopify_disconnect():
    """Remove the orders/create webhook from Shopify and delete the stored
    credentials. Idempotent."""
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    seller_id = _funnel_seller_id()
    if not seller_id:
        return _cors(jsonify({"error": "seller not resolved"})), 400
    integ = _shopify_integration_for_seller(seller_id)
    if not integ:
        return _cors(jsonify({"ok": True, "already_disconnected": True}))
    if integ.get("webhook_id"):
        _shopify_delete_webhook(integ["shop_domain"], integ["access_token"],
                                integ["webhook_id"])
    deleted = _supa_delete("shopify_integrations", {"id": integ["id"]})
    return _cors(jsonify({"ok": True, "deleted": deleted}))


@app.route("/funnel/integrations/shopify/webhook", methods=["POST"])
def funnel_integrations_shopify_webhook():
    """Receive Shopify orders/create deliveries. Authenticates with HMAC,
    resolves the seller from X-Shopify-Shop-Domain, and imports the order.
    NOT CORS / seller-header gated — Shopify calls this server-to-server."""
    raw = request.get_data()  # exact bytes — HMAC is computed over the body
    shop_domain = (request.headers.get("X-Shopify-Shop-Domain") or "").strip().lower()
    hmac_header = request.headers.get("X-Shopify-Hmac-Sha256") or ""
    topic = request.headers.get("X-Shopify-Topic") or ""

    if not shop_domain:
        return jsonify({"error": "missing shop domain"}), 401
    integ = _shopify_integration_for_domain(shop_domain)
    if not integ:
        log.warning("[shopify] webhook for unknown shop %s", shop_domain)
        return jsonify({"error": "unknown shop"}), 401
    if not _shopify_verify_hmac(integ.get("api_secret") or "", raw, hmac_header):
        log.warning("[shopify] webhook HMAC mismatch for %s", shop_domain)
        return jsonify({"error": "invalid signature"}), 401

    # Authenticated past this point.
    if topic and topic != "orders/create":
        return jsonify({"ok": True, "ignored": topic})
    try:
        payload = json.loads(raw or b"{}")
    except Exception:
        return jsonify({"error": "bad json"}), 400

    seller = fetch_seller(integ["seller_id"])
    if not seller:
        # Ack so Shopify stops retrying a webhook whose seller vanished.
        return jsonify({"ok": False, "error": "seller missing"}), 200
    try:
        result, info = _shopify_import_order(seller, integ, payload)
    except Exception as exc:
        log.exception("[shopify] order import crashed for %s: %s", shop_domain, exc)
        _supa_patch("shopify_integrations", {"id": integ["id"]},
                    {"last_error": f"import: {exc}", "status": "error"})
        # 200 so Shopify doesn't retry-storm a poison payload; the failure
        # is logged + surfaced as last_error on the Integrations page.
        return jsonify({"ok": False, "error": "import_failed"}), 200
    log.info("[shopify] order %s for %s → %s", result, shop_domain, info)
    return jsonify({"ok": True, "result": result, **info})


@app.route("/funnel/wa-sessions", methods=["GET", "OPTIONS"])
def funnel_wa_sessions():
    """List the WhatsApp sessions paired by THIS seller.

    Used by the product editor's multiselect to let the seller pin a
    product to one (or more) of their numbers. We return the same
    session UUID that ends up in products.whatsapp_session_ids — that's
    what brain's process_inbound_message matches against.

    Source of truth: the seller_whatsapp_sessions table (jid column
    stores the OpenWA session UUID for OpenWA-paired sessions). We also
    cross-reference OpenWA's /api/sessions when available so the UI can
    show the human-readable session name ("bot1", "bot12") next to the
    bare UUID.
    """
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    seller_id = _funnel_seller_id()
    if not seller_id:
        return _cors(jsonify({"error": "no seller"})), 400

    now_iso = datetime.now(timezone.utc).isoformat()

    rows = _supa_get("seller_whatsapp_sessions", {
        "seller_id": f"eq.{seller_id}",
        "select": "phone,jid,status,paired_at,last_seen_at",
        "order": "paired_at.desc",
    }) or []

    # Pull the LIVE session list from THIS seller's OpenWA gateway. Two jobs:
    #   • attach a friendly `name` ("bot1") to each known row;
    #   • surface numbers that were just linked but haven't received an
    #     inbound message yet — historically a freshly-paired number stayed
    #     invisible here until a customer wrote to it (the only auto-register
    #     path lived in openwa_resolve_seller_id, which runs on INBOUND). We
    #     now register them the moment the picker loads. Best-effort: if
    #     OpenWA is unreachable we still render whatever the table has.
    seller = fetch_seller(seller_id) or {}
    openwa_sessions: Dict[str, Dict] = {}
    try:
        api_url, api_key, _ = _resolve_openwa_config(seller)
        if api_url and api_key:
            r = httpx.get(f"{api_url}/api/sessions",
                          headers=_openwa_headers(api_key),
                          timeout=5)
            if r.status_code == 200:
                for s in r.json() or []:
                    sid = s.get("id")
                    if sid:
                        openwa_sessions[sid] = s
    except Exception as exc:
        log.debug("[wa-sessions] OpenWA list failed: %s", exc)

    # Index existing rows by jid (dedupe + name lookup) and by phone (so a
    # number re-paired under a NEW UUID heals the old row instead of forking).
    by_jid:   Dict[str, Dict] = {(r.get("jid") or ""): r for r in rows if r.get("jid")}
    by_phone: Dict[str, Dict] = {re.sub(r"\D+", "", r.get("phone") or ""): r
                                 for r in rows if (r.get("phone") or "").strip()}

    # Backfill a phone OpenWA knows but we stored blank (e.g. registered from
    # a LID-only inbound before the real number was visible).
    for jid, r in list(by_jid.items()):
        ow = openwa_sessions.get(jid) or {}
        ow_phone = re.sub(r"\D+", "", str(ow.get("phone") or ""))
        if ow_phone and not (r.get("phone") or "").strip():
            _supa_patch("seller_whatsapp_sessions", {"jid": jid},
                        {"phone": ow_phone, "last_seen_at": now_iso})
            r["phone"] = ow_phone
            by_phone[ow_phone] = r

    # Which live OpenWA sessions may THIS seller claim (auto-register)?
    #
    # A freshly-linked number used to stay invisible here until a customer
    # messaged it. We register it the instant the picker loads — but ONLY for
    # sessions we can UNAMBIGUOUSLY attribute to this seller:
    #
    #   1. Seller runs their OWN OpenWA instance (api_url/key override) →
    #      every session that gateway reports is theirs.
    #   2. The session is the seller's OWN explicitly-configured
    #      openwa_session_id (Settings → WhatsApp gateway) → theirs.
    #
    # SECURITY: on the SHARED default gateway we must NOT auto-claim a session
    # just because it is "unclaimed", and we must NOT fall back to the global
    # OPENWA_SESSION_ID as a per-seller signal. That default id is shared by
    # every seller on the gateway, and "claim if unclaimed" is first-come — so
    # either path let a brand-new seller adopt (and write seller_whatsapp_sessions
    # rows for) numbers that belong to OTHER tenants the moment they opened the
    # dashboard. On a shared gateway the brain cannot tell who linked a number,
    # so it attributes nothing automatically; a real per-tenant gateway (rule 1)
    # or an explicit openwa_session_id (rule 2) is how a number gets owned.
    owns_gateway = bool(seller.get("openwa_api_key") or seller.get("openwa_api_url"))
    own_session_id = (seller.get("openwa_session_id") or "").strip()

    def _claimable(sid: str, ow_phone: str) -> bool:
        if owns_gateway:
            return True
        return bool(own_session_id) and sid == own_session_id

    # Auto-register freshly-linked numbers (real phone, claimable, new to us).
    for sid, ow in openwa_sessions.items():
        if sid in by_jid:
            continue
        ow_phone = re.sub(r"\D+", "", str(ow.get("phone") or ""))
        if not _looks_like_real_phone(ow_phone):
            continue  # still pairing / QR screen — no number yet
        if not _claimable(sid, ow_phone):
            continue
        existing = by_phone.get(ow_phone)
        if existing:
            # Same number, new UUID → heal the jid on the existing row.
            old_jid = existing.get("jid")
            _supa_patch("seller_whatsapp_sessions", {"phone": ow_phone},
                        {"jid": sid, "status": "connected", "last_seen_at": now_iso})
            by_jid.pop(old_jid, None)
            existing["jid"] = sid
            by_jid[sid] = existing
        else:
            new_row = {
                "seller_id":    seller_id,
                "phone":        ow_phone,
                "jid":          sid,
                "status":       "connected",
                "paired_at":    now_iso,
                "last_seen_at": now_iso,
            }
            _supa_post("seller_whatsapp_sessions", new_row, prefer="return=minimal")
            rows.append(new_row)
            by_jid[sid] = new_row
            by_phone[ow_phone] = new_row
            log.info("[wa-sessions] auto-registered +%s -> seller %s (session %s)",
                     ow_phone, seller_id, sid)

    # Build the response, deduped by jid (a heal may have collapsed two rows).
    out: List[Dict] = []
    emitted: set = set()
    for r in rows:
        jid = (r.get("jid") or "").strip()
        if not jid or jid in emitted:
            continue
        emitted.add(jid)
        ow = openwa_sessions.get(jid) or {}
        out.append({
            "id":         jid,                                # stored on products.whatsapp_session_ids
            "name":       ow.get("name") or "",
            "phone":      r.get("phone") or ow.get("phone") or "",
            "status":     ow.get("status") or r.get("status") or "",
            "lastActive": ow.get("lastActive") or r.get("last_seen_at"),
        })
    return _cors(jsonify({"sessions": out}))


def _session_limit_for_seller(seller_id: str) -> int:
    """How many WhatsApp numbers this seller may link.

    • Free trial  → TRIAL_SESSIONS (1, per the trial card).
    • Paid tier   → that tier's sessions_included.
    • Otherwise   → FREE_TIER_SESSIONS.
    Never raises; defaults to the free cap on any error."""
    try:
        if _trial_status_for_seller(seller_id).get("is_trial"):
            return TRIAL_SESSIONS
        org_id = _resolve_organization_id_for_seller(seller_id)
        if org_id:
            rows = _supa_get("organizations", {
                "id": f"eq.{org_id}", "select": "plan", "limit": "1",
            }) or []
            plan = (rows[0].get("plan") if rows else "") or ""
            cfg = PRICING_TIERS.get(plan, {})
            if cfg:
                return int(cfg.get("sessions_included", FREE_TIER_SESSIONS))
    except Exception:
        pass
    return FREE_TIER_SESSIONS


@app.route("/funnel/wa-sessions/register", methods=["POST", "OPTIONS"])
def funnel_wa_sessions_register():
    """Claim a WhatsApp session the seller just created for THIS seller.

    The dashboard creates sessions directly on the shared OpenWA gateway
    (POST /api/sessions), which is tenant-blind. This endpoint is how the
    seller→session ownership row gets written, so the number persists in the
    seller's list after a refresh and inbound messages route to them.

    SECURITY: we register only when the jid is currently UNCLAIMED (or already
    owned by this same seller). If another seller already owns it we refuse —
    a seller can only attach a session whose UUID they just minted via their
    own create action (those UUIDs are unguessable and never exposed to other
    tenants), never adopt an established number that belongs to someone else.
    This is the safe, explicit counterpart to the auto-claim that used to leak
    every unclaimed live session into whichever account opened the picker.
    """
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    seller_id = _funnel_seller_id()
    if not seller_id:
        return _cors(jsonify({"error": "no seller"})), 400
    body = request.get_json(silent=True) or {}
    jid = (body.get("jid") or "").strip()
    if not jid:
        return _cors(jsonify({"error": "jid required"})), 400
    phone = re.sub(r"\D+", "", str(body.get("phone") or ""))

    existing = _supa_get("seller_whatsapp_sessions", {
        "jid": f"eq.{jid}",
        "select": "seller_id",
        "limit": "1",
    }) or []
    if existing:
        owner = existing[0].get("seller_id")
        if owner and owner != seller_id:
            # Belongs to another tenant — never steal it.
            return _cors(jsonify({"error": "already_owned"})), 409
        # Already ours → idempotent success. Re-ensure the webhook in case the
        # gateway dropped it (redeploy / volume reset) so the bot doesn't go mute.
        _ensure_session_webhook(jid)
        return _cors(jsonify({"ok": True, "jid": jid, "status": "already_owned"})), 200

    # Free-trial hard gate — block connecting a NEW WhatsApp number once the
    # trial has ended (no active paid plan). Re-claiming an already-owned jid
    # (handled above) stays allowed so refreshes don't break. Admin lifts it.
    _acc = _seller_access_state(seller_id)
    if not _acc.get("allowed"):
        log.info("[wa-sessions] seller %s blocked from new session (%s)", seller_id, _acc.get("reason"))
        return _trial_blocked_response(_acc, "connect_session")

    # ── Per-plan WhatsApp-session cap (free trial = 1) ──────────────────
    # This jid is NEW (not already owned, handled above). Only let the seller
    # claim it if they're under their cap. Count DISTINCT owned jids so a
    # healed/duplicate row never inflates the tally.
    limit = _session_limit_for_seller(seller_id)
    owned_rows = _supa_get("seller_whatsapp_sessions", {
        "seller_id": f"eq.{seller_id}",
        "select": "jid",
    }) or []
    owned_count = len({(r.get("jid") or "") for r in owned_rows if r.get("jid")})
    if owned_count >= limit:
        log.info("[wa-sessions] seller %s blocked: %d/%d sessions (cap)",
                 seller_id, owned_count, limit)
        return _cors(jsonify({
            "error": "session_limit",
            "limit": limit,
            "owned": owned_count,
            "message": (f"Your current plan allows {limit} WhatsApp "
                        f"session{'s' if limit != 1 else ''}. "
                        f"Upgrade to connect more."),
        })), 403

    now_iso = datetime.now(timezone.utc).isoformat()
    row = {
        "seller_id":    seller_id,
        "phone":        phone,          # '' until the number actually pairs
        "jid":          jid,
        # status CHECK on seller_whatsapp_sessions allows ONLY
        # pending|connected|disconnected|expired. A freshly-created, not-yet
        # scanned session is 'pending' (funnel_wa_sessions overrides the
        # display status from the live gateway anyway: qr_ready/ready/etc.).
        "status":       "pending",
        "paired_at":    now_iso,
        "last_seen_at": now_iso,
    }
    created = _supa_post("seller_whatsapp_sessions", row)
    if created:
        log.info("[wa-sessions] seller %s registered new session %s", seller_id, jid)
        _ensure_session_webhook(jid)
        return _cors(jsonify({"ok": True, "jid": jid, "status": "registered"})), 200

    # Insert failed. The usual cause is the unique(seller_id, phone) constraint:
    # a seller has at most ONE not-yet-scanned row (phone=''), so creating a
    # second session before pairing the first collides. You scan one QR at a
    # time, so reuse that pending slot — point it at the newest jid rather than
    # failing (which would make the new card vanish on the next refetch).
    if not phone:
        repointed = _supa_patch(
            "seller_whatsapp_sessions",
            {"seller_id": seller_id, "phone": ""},
            {"jid": jid, "status": "pending", "paired_at": now_iso, "last_seen_at": now_iso},
        )
        if repointed:
            log.info("[wa-sessions] seller %s re-pointed pending slot → %s", seller_id, jid)
            return _cors(jsonify({"ok": True, "jid": jid, "status": "repointed"})), 200

    log.warning("[wa-sessions] register failed for seller %s jid %s", seller_id, jid)
    return _cors(jsonify({"error": "register_failed"})), 500


@app.route("/funnel/wa-sessions/<jid>", methods=["DELETE", "OPTIONS"])
def funnel_wa_sessions_unregister(jid: str):
    """Drop THIS seller's ownership row for a WhatsApp session.

    The dashboard deletes the live session on the gateway (DELETE /api/sessions/:id)
    and then calls this, so the seller→session row in seller_whatsapp_sessions goes
    away too. Without it the number resurrects in the list on the next reload — the
    list's source of truth is this table, not the gateway. This is also the ONLY way
    to clear a stale/orphaned row whose gateway session no longer exists (gateway
    returns 404 on delete): the dashboard treats that 404 as "already gone" and still
    calls here to finish the cleanup.

    SECURITY: scoped to the caller via seller_id — a seller can only unregister a jid
    they own, never detach another tenant's number.

    Idempotent: if the row is already gone (or was never this seller's) we still
    return ok — the caller's goal, "this is no longer mine", already holds.
    """
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    seller_id = _funnel_seller_id()
    if not seller_id:
        return _cors(jsonify({"error": "no seller"})), 400
    jid = (jid or "").strip()
    if not jid:
        return _cors(jsonify({"error": "jid required"})), 400

    _supa_delete("seller_whatsapp_sessions", {
        "seller_id": f"eq.{seller_id}",
        "jid":       f"eq.{jid}",
    })
    log.info("[wa-sessions] seller %s unregistered session %s", seller_id, jid)
    return _cors(jsonify({"ok": True, "jid": jid, "status": "unregistered"})), 200


@app.route("/funnel/orders", methods=["GET", "OPTIONS"])
def funnel_orders():
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    seller_id = _funnel_seller_id()
    if not seller_id:
        return _cors(jsonify({"error": "no seller"})), 400
    # `whatsapp_session_ids` rides along on the embedded product so the
    # dashboard can scope orders to the WhatsApp number the seller is
    # currently viewing (the global session switcher). An order inherits
    # its product's number assignment — the same axis the seller already
    # configures per product (migration 0006).
    rows = _supa_get("orders", {
        "seller_id": f"eq.{seller_id}",
        "select": "id,customer_name,customer_phone,customer_address,customer_city,country_code,quantity,unit_price,total_price,currency,status,sheets_sync_status,created_at,products(name,kind,whatsapp_session_ids)",
        "order": "created_at.desc",
        "limit": "200",
    }) or []
    return _cors(jsonify({"orders": rows}))


@app.route("/funnel/orders/<order_id>/retry-sheet", methods=["POST", "OPTIONS"])
def funnel_order_retry_sheet(order_id: str):
    """Re-push a previously-failed order to whichever Sheets webhook the
    seller has configured *right now*. Useful right after the seller
    fixes a bad webhook URL — they don't have to wait for a new order
    to test, they just click Retry on the failed row.

    Re-builds the same row payload that build_and_push_order originally
    sent (sku, Customer_Name, Phone, address, Quantity, total_price + extras)
    so the row that lands in the sheet is identical to a fresh push.
    """
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    seller_id = _funnel_seller_id()
    if not seller_id:
        return _cors(jsonify({"error": "no seller"})), 400

    rows = _supa_get("orders", {
        "id": f"eq.{order_id}",
        "seller_id": f"eq.{seller_id}",
        "select": "*",
        "limit": "1",
    }) or []
    if not rows:
        return _cors(jsonify({"error": "order not found"})), 404
    order = rows[0]

    seller = fetch_seller(seller_id) or {}
    product = None
    pid = order.get("product_id")
    if pid:
        prods = _supa_get("products", {"id": f"eq.{pid}", "select": "*", "limit": "1"}) or []
        product = prods[0] if prods else None

    currency = order.get("currency") or ""
    total_price = float(order.get("total_price") or 0)
    address_combined = (
        (order.get("customer_address") or "").strip()
        + (", " + (order.get("customer_city") or "").strip() if order.get("customer_city") else "")
    ).strip(", ").strip()
    sheet_payload = {
        # sku stays empty by design — seller fills with their own SKU.
        "sku":           "",
        "Customer_Name": order.get("customer_name") or "",
        "Phone":         order.get("customer_phone") or "",
        "address":       address_combined,
        "Quantity":      order.get("quantity") or 1,
        # Plain number, no currency suffix — seller's sheet handles formatting.
        "total_price":   total_price,
        "id":            order.get("id"),
        "currency":      currency,
        "country_code":  order.get("country_code") or "",
        "customer_jid":  order.get("customer_jid") or "",
        "created_at":    order.get("created_at"),
    }
    ok = push_order_to_sheet(seller, product, sheet_payload)
    new_status = "synced" if ok else "failed"
    _supa_patch("orders", {"id": order_id}, {
        "sheets_sync_status": new_status,
        "sheets_sync_at": datetime.now(timezone.utc).isoformat() if ok else None,
    })
    if not ok:
        # Surface the precise failure reason so the dashboard can show it.
        url = _resolve_sheets_webhook(seller, product)
        if not url:
            return _cors(jsonify({"ok": False, "error": "no_webhook_configured",
                                  "message": "No Sheets webhook URL configured for this product or seller."})), 400
        return _cors(jsonify({"ok": False, "error": "push_failed",
                              "message": "POST to the Sheets webhook didn't succeed. Check the URL is an Apps Script Web App /exec URL."})), 502

    return _cors(jsonify({"ok": True, "status": new_status})), 200


def _conversation_readiness(pending: Optional[Dict],
                            status: Optional[str]) -> Dict:
    """Cheap 'how close to ordering' signal for the inbox right-panel.
    Returns {level: 0-4, stage: str} derived from collected order fields —
    no extra DB hit, no LLM call. Mirrors the funnel stages loosely so the
    operator can triage hot leads at a glance (à la the competitor's
    'Readiness lvl' badge)."""
    pending = pending if isinstance(pending, dict) else {}
    st = (status or "").lower()
    if st in ("closed", "ordered", "completed", "paid") or pending.get("order_placed"):
        return {"level": 4, "stage": "ordered"}
    have_name = bool(pending.get("customer_name") or pending.get("name"))
    have_qty = bool(pending.get("quantity"))
    have_addr = bool(pending.get("address") or pending.get("city"))
    score = int(have_name) + int(have_qty) + int(have_addr)
    if score >= 3:
        return {"level": 3, "stage": "confirming"}
    if score >= 1:
        return {"level": 2, "stage": "collecting"}
    # Any pending state at all (beyond bookkeeping keys) → browsing.
    meaningful = {k for k in pending.keys()
                  if k not in ("history_reset_at", "agent_paused",
                               "lead_pushed", "order_placed")}
    if meaningful:
        return {"level": 1, "stage": "browsing"}
    return {"level": 0, "stage": "new"}


def _conversation_decorate(row: Dict, last: Optional[Dict] = None) -> Dict:
    """Attach inbox-friendly derived fields to a conversation row."""
    pof = row.get("pending_order_fields") or {}
    if not isinstance(pof, dict):
        pof = {}
    row["customer_name"] = pof.get("customer_name") or pof.get("name") or ""
    row["agent_paused"] = bool(pof.get("agent_paused"))
    row["readiness"] = _conversation_readiness(pof, row.get("status"))
    if last is not None:
        row["last_message"] = (last or {}).get("content") or ""
        row["last_message_role"] = (last or {}).get("role") or ""
    return row


@app.route("/funnel/conversations", methods=["GET", "OPTIONS"])
def funnel_conversations():
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    seller_id = _funnel_seller_id()
    if not seller_id:
        return _cors(jsonify({"error": "no seller"})), 400
    rows = _supa_get("customer_conversations", {
        "seller_id": f"eq.{seller_id}",
        "select": "id,customer_jid,customer_phone,country_code,language_code,status,started_at,last_message_at,pending_order_fields,detected_product_id",
        "order": "last_message_at.desc",
        "limit": "100",
    }) or []
    # Attach a last-message preview per conversation in ONE batched query
    # (PostgREST in.(...) newest-first; keep the first row seen per cid).
    ids = [r.get("id") for r in rows if r.get("id")]
    previews: Dict[str, Dict] = {}
    if ids:
        msgs = _supa_get("messages", {
            "conversation_id": f"in.({','.join(ids)})",
            "select": "conversation_id,role,content,created_at",
            "order": "created_at.desc",
            "limit": "600",
        }) or []
        for m in msgs:
            cid = m.get("conversation_id")
            if cid and cid not in previews:
                previews[cid] = m

    # Per-session scoping for the dashboard's global session switcher.
    # A conversation is "about" the product the bot detected for it; that
    # product is pinned to one or more WhatsApp numbers (migration 0006).
    # We resolve detected_product_id → that product's whatsapp_session_ids
    # in ONE batched query and expose it as `session_jids` so the inbox can
    # filter chats by the number the seller is viewing. Chats with no
    # detected product yet carry [] (they only show under "All sessions").
    prod_sessions: Dict[str, List[str]] = {}
    pids = sorted({r.get("detected_product_id") for r in rows if r.get("detected_product_id")})
    if pids:
        prods = _supa_get("products", {
            "id": f"in.({','.join(pids)})",
            "select": "id,whatsapp_session_ids",
        }) or []
        for p in prods:
            prod_sessions[p.get("id")] = p.get("whatsapp_session_ids") or []

    for r in rows:
        _conversation_decorate(r, previews.get(r.get("id")))
        r["session_jids"] = prod_sessions.get(r.get("detected_product_id")) or []
    return _cors(jsonify({"conversations": rows}))


@app.route("/funnel/conversations/<cid>/messages", methods=["GET", "OPTIONS"])
def funnel_conversation_messages(cid: str):
    """Full message thread for ONE conversation (inbox center pane)."""
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    seller_id = _funnel_seller_id()
    if not seller_id:
        return _cors(jsonify({"error": "no seller"})), 400
    # Ownership check — never let one tenant read another's thread.
    conv = _supa_get("customer_conversations", {
        "id": f"eq.{cid}",
        "seller_id": f"eq.{seller_id}",
        "select": "id,customer_jid,customer_phone,country_code,language_code,status,started_at,last_message_at,pending_order_fields",
        "limit": "1",
    })
    if not conv:
        return _cors(jsonify({"error": "not found"})), 404
    conv = _conversation_decorate(conv[0])
    msgs = _supa_get("messages", {
        "conversation_id": f"eq.{cid}",
        "select": "id,role,content,created_at",
        "order": "created_at.asc",
        "limit": "500",
    }) or []
    return _cors(jsonify({"conversation": conv, "messages": msgs}))


@app.route("/funnel/conversations/<cid>/send", methods=["POST", "OPTIONS"])
def funnel_conversation_send(cid: str):
    """Send a message to the customer AS the operator (human takeover).
    Delivers via the seller's OpenWA session, records it in-thread, and
    pauses the bot for this conversation so it doesn't talk over the human."""
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    seller_id = _funnel_seller_id()
    if not seller_id:
        return _cors(jsonify({"error": "no seller"})), 400
    if not _funnel_only_localhost():
        return _cors(jsonify({"error": "forbidden"})), 403
    body = request.get_json(silent=True) or {}
    text = (body.get("text") or "").strip()
    if not text:
        return _cors(jsonify({"error": "empty"})), 400
    conv = _supa_get("customer_conversations", {
        "id": f"eq.{cid}",
        "seller_id": f"eq.{seller_id}",
        "select": "id,customer_jid,pending_order_fields",
        "limit": "1",
    })
    if not conv:
        return _cors(jsonify({"error": "not found"})), 404
    conv = conv[0]
    seller = fetch_seller(seller_id) or {}
    api_url, api_key, sid = _resolve_openwa_config(seller)
    ok = openwa_send_text(conv["customer_jid"], text,
                          session_id=sid, api_url=api_url, api_key=api_key,
                          human_like=False)
    if not ok:
        return _cors(jsonify({"ok": False, "error": "send-failed"})), 502
    # Record the operator's message in-thread (role 'assistant' keeps the
    # LLM-history shape valid if the bot is resumed later).
    save_message(cid, "assistant", text)
    pof = conv.get("pending_order_fields") or {}
    if not isinstance(pof, dict):
        pof = {}
    pof["agent_paused"] = True  # manual send = take over
    _supa_patch("customer_conversations", {"id": cid}, {
        "pending_order_fields": pof,
        "last_message_at": datetime.now(timezone.utc).isoformat(),
    })
    return _cors(jsonify({"ok": True, "agent_paused": True}))


@app.route("/funnel/conversations/<cid>/agent", methods=["POST", "OPTIONS"])
def funnel_conversation_agent(cid: str):
    """Toggle the bot for ONE conversation. Body: {paused: bool}.
    paused=true → human takeover (bot silent); paused=false → bot resumes."""
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    seller_id = _funnel_seller_id()
    if not seller_id:
        return _cors(jsonify({"error": "no seller"})), 400
    if not _funnel_only_localhost():
        return _cors(jsonify({"error": "forbidden"})), 403
    body = request.get_json(silent=True) or {}
    paused = bool(body.get("paused"))
    conv = _supa_get("customer_conversations", {
        "id": f"eq.{cid}",
        "seller_id": f"eq.{seller_id}",
        "select": "id,pending_order_fields",
        "limit": "1",
    })
    if not conv:
        return _cors(jsonify({"error": "not found"})), 404
    pof = conv[0].get("pending_order_fields") or {}
    if not isinstance(pof, dict):
        pof = {}
    pof["agent_paused"] = paused
    _supa_patch("customer_conversations", {"id": cid},
                {"pending_order_fields": pof})
    return _cors(jsonify({"ok": True, "agent_paused": paused}))


@app.route("/funnel/settings", methods=["GET", "PATCH", "OPTIONS"])
def funnel_settings():
    if request.method == "OPTIONS":
        return _cors(jsonify({}))
    seller_id = _funnel_seller_id()
    if not seller_id:
        return _cors(jsonify({"error": "no seller"})), 400
    if request.method == "GET":
        row = fetch_seller(seller_id) or {}
        # Never leak the OpenWA api key to the browser even though localhost
        # access is supposed to be safe — easier to be paranoid.
        masked = dict(row)
        if masked.get("openwa_api_key"):
            k = masked["openwa_api_key"]
            masked["openwa_api_key_masked"] = (k[:8] + "…" + k[-4:]) if len(k) > 16 else "set"
            masked.pop("openwa_api_key", None)
        return _cors(jsonify({"seller": masked}))
    if not _funnel_only_localhost():
        return _cors(jsonify({"error": "forbidden"})), 403
    body = request.get_json(silent=True) or {}
    allowed = {"business_name", "country_codes", "default_language",
               "bot_persona", "sheets_webhook_url", "daily_msg_cap",
               "openwa_api_url", "openwa_api_key", "openwa_session_id",
               "business_category", "tone_of_voice"}
    updates = {k: v for k, v in body.items() if k in allowed}
    # business_category drives both the dashboard's dynamic multi-service UI
    # and the bot's persona guidance. Validate the value against the DB CHECK
    # constraint set so a typo returns a clean 400 instead of a raw Postgres
    # constraint violation. An empty string clears it (→ NULL → e-commerce).
    if "business_category" in updates:
        bc = (str(updates["business_category"] or "").strip().lower()) or None
        if bc is not None and bc not in VALID_BUSINESS_CATEGORIES:
            return _cors(jsonify({"error": "invalid business_category"})), 400
        updates["business_category"] = bc
    if "tone_of_voice" in updates:
        tone = (str(updates["tone_of_voice"] or "").strip().lower()) or None
        if tone is not None and tone not in {"professional", "friendly", "persuasive"}:
            return _cors(jsonify({"error": "invalid tone_of_voice"})), 400
        updates["tone_of_voice"] = tone
    if updates:
        _supa_patch("sellers", {"id": seller_id}, updates)
    return _cors(jsonify({"ok": True}))


@app.route("/shutdown", methods=["POST"])
def shutdown():
    """Exit so the supervisor respawns with the latest brain.py. Localhost-only."""
    remote = request.remote_addr or ""
    if remote not in ("127.0.0.1", "::1"):
        return jsonify({"error": "forbidden", "remote": remote}), 403
    log.info("Shutdown requested via /shutdown — exiting (99) for respawn.")
    threading.Timer(0.25, lambda: os._exit(99)).start()
    return jsonify({"ok": True, "exit_code": 99})


# ── Entry point ──────────────────────────────────────────────────────────
if __name__ == "__main__":
    if not OPENROUTER_API_KEY:
        log.warning(
            "OPENROUTER_API_KEY is empty — paste it into .env from the "
            "MediaHubAccess project. /webhook will return empty replies "
            "until then."
        )
    if not SUPABASE_SERVICE_KEY:
        log.warning(
            "SUPABASE_SERVICE_KEY is empty — DB reads + writes will fail. "
            "Get from Supabase Dashboard → Settings → API → service_role."
        )
    log.info("Starting brain on port %s (model=%s, supabase=%s)",
             PORT, DEFAULT_MODEL, "configured" if SUPABASE_SERVICE_KEY else "missing")

    # Register the OpenWA webhook so inbound messages flow to us without
    # the operator clicking around in the dashboard. Best-effort: if
    # OpenWA isn't up yet, the brain still starts and the operator can
    # register manually via the OpenWA UI later.
    #
    # OpenWA's NestJS @IsUrl() validator rejects the bare "localhost"
    # hostname (it requires a TLD or an IP), so we always feed it 127.0.0.1
    # for local installs. The host.docker.internal alias is used only when
    # this brain is itself running inside a Docker container.
    if OPENWA_API_KEY and OPENWA_SESSION_ID:
        # Where the gateway POSTs inbound messages. In the cloud the gateway is
        # a SEPARATE service, so it can't reach 127.0.0.1 — pick the brain's own
        # reachable base URL, in priority order:
        #   1. PUBLIC_BASE_URL   — explicit (Railway public/private URL, tunnel…)
        #   2. RAILWAY_PRIVATE_DOMAIN — auto, when deployed on Railway
        #   3. host.docker.internal — brain itself inside Docker locally
        #   4. 127.0.0.1         — plain local dev (unchanged behaviour)
        _rail = os.environ.get("RAILWAY_PRIVATE_DOMAIN")
        if PUBLIC_BASE_URL:
            _wh_base = PUBLIC_BASE_URL
        elif _rail:
            _wh_base = f"http://{_rail}:{PORT}"
        elif os.environ.get("OPENWA_INSIDE_DOCKER"):
            _wh_base = f"http://host.docker.internal:{PORT}"
        else:
            _wh_base = f"http://127.0.0.1:{PORT}"
        callback = f"{_wh_base}/openwa/webhook"
        # Defer to a thread so a slow OpenWA startup doesn't block Flask.
        def _register():
            try:
                time.sleep(1)
                openwa_register_webhook(callback)
            except Exception as exc:
                log.warning("[openwa] startup register exception: %s", exc)
        threading.Thread(target=_register, daemon=True).start()
        log.info("OpenWA: API=%s session=%s; webhook → %s",
                 OPENWA_API_URL, OPENWA_SESSION_ID, callback)
    else:
        log.info("OpenWA: not configured (set OPENWA_API_KEY + OPENWA_SESSION_ID in .env)")

    app.run(host=HOST, port=PORT, debug=False)
