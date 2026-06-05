"""2-Agent SaaS confirmation pipeline.

Collapsed from the previous 4-agent design after measuring that two of
those agents (the deterministic field validator + the closing wrapper)
added cost and latency without adding intelligence. The remaining two
agents have crisp, opposite responsibilities:

    ┌──────────────────────────────────────────────────────────────────┐
    │ AGENT 1 — Orchestrator / Validator           (cheap model + JSON)│
    │   in : raw message + chat history + current collected fields    │
    │   out: STRICT JSON with                                         │
    │       intent_type        — product_purchase | service_booking | │
    │                            technical_support | general_faq |    │
    │                            complaint                            │
    │       detected_language  — ary | ar | fr | en                   │
    │       customer_vibe      — worried_about_quality | urgent |     │
    │                            hesitant_on_price | formal | angry | │
    │                            enthusiastic | neutral               │
    │       extracted_fields   — name, city, address, quantity (or    │
    │                            booking_date / duration /            │
    │                            issue_details for services)          │
    │       city_matched       — bool, true when normalize_city hit   │
    │       address_incomplete — bool                                 │
    │       lead_priority      — 🟢 Hot Lead | 🟡 Medium Support |    │
    │                            🔴 Escalated to Human                │
    │                                                                  │
    │ AGENT 2 — Communicator / Closer            (premium model + text)│
    │   in : Agent 1's output + collected fields + chat history       │
    │   out: PLAIN TEXT reply in the locked language                  │
    │   Branches:                                                     │
    │     • collection mode — sequential funnel, never re-asks        │
    │     • closing mode — fires when all required fields present,    │
    │       writes a UNIQUE vibe-tailored recap + confirm question    │
    │       (anti-repetition: NEVER 'thank you for your trust')       │
    └──────────────────────────────────────────────────────────────────┘

Critical SaaS guarantees enforced here:
  1. Triple-tier JSON fallback — Agent 1 NEVER returns nothing. If
     response_format=json_object fails (empty content + stop), retry
     without the format. If still empty, fall back to deterministic
     regex extraction so the bot keeps replying.
  2. Language lock — `stored_language` from the conversation row always
     wins over fresh detection, so the bot never flips mid-thread.
  3. Field validation pre-Excel — city normalization + address regex
     run before fields are merged into pending_order_fields, so what
     lands in the seller's spreadsheet is already canonical.
  4. Cost split — Agent 1 uses a configurable cheap model (defaults to
     gpt-4o-mini); Agent 2 uses the seller's premium model. ~3× cost
     reduction per turn vs single-call architecture.
"""
from __future__ import annotations

import logging
import os
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

log = logging.getLogger("brain.agents")


# ════════════════════════════════════════════════════════════════════════
# CONFIG — model identifiers, allowed enums
# ════════════════════════════════════════════════════════════════════════

# Agent 1 = cheap analytical model. Env override so the SaaS operator
# can pin a specific cheap model per cost tier.
AGENT1_MODEL_ENV = "OPENROUTER_AGENT1_MODEL"
AGENT1_DEFAULT_MODEL = "openai/gpt-4o-mini"

# Allowed enum values — Agent 1 is forced to pick from these. Adding
# new values is safe; old values stay live.
ALLOWED_INTENTS = (
    "product_purchase",
    "service_booking",
    "technical_support",
    "general_faq",
    "complaint",
)
ALLOWED_VIBES = (
    "worried_about_quality",
    "urgent",
    "hesitant_on_price",
    "formal",
    "angry",
    "enthusiastic",
    "neutral",
)
ALLOWED_PRIORITIES = (
    "🟢 Hot Lead",
    "🟡 Medium Support",
    "🔴 Escalated to Human",
)


# ════════════════════════════════════════════════════════════════════════
# STATE
# ════════════════════════════════════════════════════════════════════════

@dataclass
class ConversationState:
    """Per-turn snapshot built once at the top of the pipeline. Mutated
    by Agent 1 (fills intent/lang/vibe/priority + normalizes fields),
    consumed by Agent 2 (uses everything to write the reply)."""
    seller_id: str
    conversation_id: str
    from_jid: str
    phone: str = ""

    # Conversation-level pinned language. Set once on first detection
    # and never changes — the "stored wins over sniffed" rule.
    detected_language: str = ""

    # Cumulative across turns. Bot 1 extracts THIS turn's fields and
    # the caller merges them into pending_order_fields.
    collected_fields: Dict[str, Any] = field(default_factory=dict)

    # Agent 1 outputs.
    intent_type: str = "product_purchase"
    customer_vibe: str = "neutral"
    lead_priority: str = "🟢 Hot Lead"
    address_incomplete: bool = False
    city_matched: bool = False

    # Logging metadata surfaced to the seller in Excel.
    bot_internal_notes: List[str] = field(default_factory=list)

    # Working copies.
    raw_message: str = ""
    cleaned_message: str = ""

    def note(self, msg: str) -> None:
        self.bot_internal_notes.append(msg)

    def required_keys(self, kind: str) -> Tuple[str, ...]:
        return (("name", "service_date", "city", "address")
                if kind == "service"
                else ("name", "city", "address"))

    def has_required(self, kind: str) -> bool:
        for k in self.required_keys(kind):
            v = self.collected_fields.get(k)
            if not (v and (str(v).strip() if isinstance(v, str) else v)):
                return False
        return True

    def notes_summary(self) -> str:
        return " | ".join(self.bot_internal_notes) if self.bot_internal_notes else ""


# ════════════════════════════════════════════════════════════════════════
# DETERMINISTIC HELPERS — city lookup, address regex, message cleanup
# ════════════════════════════════════════════════════════════════════════

# Cities the brain knows how to normalize. Each canonical name → tuple
# of normalized aliases. Sellers operating in new markets just append
# entries here.
CITY_ALIASES: Dict[str, Tuple[str, ...]] = {
    # ── Morocco ──
    "Casablanca": ("casablanca", "casa", "kazablanka", "dar lbida",
                   "dar lbi9a", "dar baida", "الدار البيضاء", "كازا",
                   "كازابلانكا"),
    "Rabat":      ("rabat", "rabt", "rbat", "ribat", "الرباط"),
    "Marrakech":  ("marrakech", "marrakesh", "marakech", "mraksh",
                   "merrakech", "مراكش"),
    "Tanger":     ("tanger", "tangier", "tanja", "tnja", "tanjja",
                   "طنجة"),
    "Agadir":     ("agadir", "agadeer", "agadyr", "أكادير", "اكادير"),
    "Fes":        ("fes", "fez", "fas", "faas", "فاس"),
    "Meknes":     ("meknes", "meknès", "mknas", "miknas", "مكناس"),
    "Oujda":      ("oujda", "wjda", "wajda", "ujda", "وجدة"),
    "Tetouan":    ("tetouan", "titwan", "tatwan", "tetwan", "تطوان"),
    "Kenitra":    ("kenitra", "qnitra", "knitra", "القنيطرة"),
    "Sale":       ("sale", "sala", "salé", "سلا"),
    "Nador":      ("nador", "nadour", "الناظور"),
    "Mohammedia": ("mohammedia", "mohamedia", "fdala", "المحمدية"),
    "El Jadida":  ("el jadida", "eljadida", "mazaghan", "الجديدة"),
    "Beni Mellal":("beni mellal", "beni mlal", "bni mllal", "بني ملال"),
    "Khouribga":  ("khouribga", "khribga", "خريبكة"),
    "Settat":     ("settat", "settate", "سطات"),
    "Berkane":    ("berkane", "berkan", "بركان"),
    "Larache":    ("larache", "larach", "العرائش"),
    "Taza":       ("taza", "tazi", "تازة"),
    "Tinghir":    ("tinghir", "tnjdad", "tinejdad", "تنغير"),
    "Ouarzazate": ("ouarzazate", "warzazat", "ورزازات"),
    "Errachidia": ("errachidia", "rachidia", "رشيدية"),
    # ── Guinea ──
    "Conakry":    ("conakry", "konakry", "konacry", "كوناكري"),
    "Kindia":     ("kindia",),
    "Boke":       ("boke", "boké"),
    "Kankan":     ("kankan",),
    "Labe":       ("labe", "labé"),
    "Nzerekore":  ("nzerekore", "nzérékoré", "n'zerekore"),
    # ── Côte d'Ivoire ──
    "Abidjan":    ("abidjan", "abj"),
    "Yamoussoukro":("yamoussoukro", "yamssoukro"),
    "Bouake":     ("bouake", "bouaké"),
    # ── Senegal ──
    "Dakar":      ("dakar", "dkar"),
    "Thies":      ("thies", "thiès"),
}


def _norm(s: str) -> str:
    """Lower + strip accents/diacritics for matching."""
    if not s:
        return ""
    nfkd = unicodedata.normalize("NFKD", s)
    no_acc = "".join(ch for ch in nfkd if not unicodedata.combining(ch))
    return no_acc.lower().strip()


# Reverse alias → canonical lookup, built once.
_CITY_LOOKUP: Dict[str, str] = {}
for _canonical, _aliases in CITY_ALIASES.items():
    _CITY_LOOKUP[_norm(_canonical)] = _canonical
    for _alias in _aliases:
        _CITY_LOOKUP[_norm(_alias)] = _canonical


def normalize_city(raw: Optional[str]) -> Tuple[Optional[str], bool]:
    """Canonical city name + bool indicating whether the input matched
    our aliases. Unrecognized cities pass through trimmed but `matched`
    is False so the seller can review."""
    if not raw:
        return None, False
    candidate = _norm(raw)
    if candidate in _CITY_LOOKUP:
        return _CITY_LOOKUP[candidate], True
    for alias, canonical in _CITY_LOOKUP.items():
        if re.search(rf"\b{re.escape(alias)}\b", candidate):
            return canonical, True
    return raw.strip(), False


_ADDR_HAS_NUMBER = re.compile(r"\b\d{1,5}\b")
_ADDR_STREET_HINTS = re.compile(
    r"\b(rue|avenue|av|bd|boulevard|hay|quartier|cité|cite|résidence|"
    r"residence|imm|immeuble|app|appartement|"
    r"شارع|زنقة|حي|درب|إقامة|عمارة|رقم|شقة)\b",
    re.IGNORECASE,
)


def address_completeness(addr: Optional[str]) -> Tuple[bool, str]:
    """(is_complete, reason). Complete = has a house number OR a
    street/landmark keyword. Bare 'Casablanca' or 'centre ville' fail."""
    if not addr or not addr.strip():
        return False, "address_missing"
    s = addr.strip()
    if len(s) < 6:
        return False, "address_too_short"
    has_num = bool(_ADDR_HAS_NUMBER.search(s))
    has_street = bool(_ADDR_STREET_HINTS.search(s))
    if not (has_num or has_street):
        return False, "address_no_street_or_number"
    return True, "address_ok"


_NAME_PREFIXES = (
    "smiti ", "smiyti ", "smitiya ",
    "je m'appelle ", "je mappelle ",
    "ana ", "ana smiti ",
    "my name is ", "i am ", "i'm ",
    "اسمي ", "سميتي ", "أنا ",
)


def clean_name(raw: Optional[str]) -> Optional[str]:
    """Strip the 'my name is' prefix in any of the supported languages
    and take just the first name token."""
    if not raw:
        return None
    n = raw.strip()
    low = n.lower()
    for p in _NAME_PREFIXES:
        if low.startswith(p):
            n = n[len(p):].strip()
            low = n.lower()
            break
    n = n.split()[0] if n else ""
    return n or None


def _clean_message(raw: str) -> str:
    """Normalize whitespace + strip control chars + collapse emoji floods."""
    if not raw:
        return ""
    cleaned = "".join(
        ch for ch in raw
        if ch == "\n" or unicodedata.category(ch)[0] != "C"
    )
    cleaned = re.sub(r"[ \t]+", " ", cleaned).strip()
    cleaned = re.sub(r"(\W)\1{3,}", r"\1\1\1", cleaned)
    return cleaned


# ════════════════════════════════════════════════════════════════════════
# AGENT 1 — Orchestrator / Validator
# ════════════════════════════════════════════════════════════════════════

def _build_agent1_prompt(state: ConversationState,
                         kind: str,
                         recent_history: List[Dict]) -> str:
    """System prompt for Agent 1. Strict JSON output, single-turn focus."""
    history_block = []
    for m in (recent_history or [])[-6:]:
        role = m.get("role", "")
        content = (m.get("content") or "")[:200]
        if role in ("user", "assistant") and content:
            history_block.append(f"{role}: {content}")
    history_str = "\n".join(history_block) if history_block else "(none)"
    collected_str = ", ".join(
        f"{k}={v!r}" for k, v in (state.collected_fields or {}).items()
        if v and k not in ("history_reset_at", "lead_pushed_at",
                           "last_order_sig", "last_order_at",
                           "gallery_sent_at", "last_closer_run_at",
                           "lead_score", "bot_internal_notes",
                           "lead_priority")
    ) or "(empty)"

    if kind == "service":
        field_schema = (
            "  \"extracted_fields\": {\n"
            "    \"customer_name\": <string or null>,\n"
            "    \"booking_date\":  <string or null>,\n"
            "    \"duration\":      <string or null>,\n"
            "    \"city\":          <string or null>,\n"
            "    \"address\":       <string or null>,\n"
            "    \"requirements\":  <string or null>,\n"
            "    \"issue_details\": <string or null>\n"
            "  },"
        )
    else:
        field_schema = (
            "  \"extracted_fields\": {\n"
            "    \"customer_name\": <string or null>,\n"
            "    \"city\":          <string or null>,\n"
            "    \"address\":       <string or null>,\n"
            "    \"quantity\":      <integer or null>\n"
            "  },"
        )

    return (
        "You are Agent 1 of a 2-agent WhatsApp commerce bot. Your job is "
        "to ANALYZE the customer's latest message + the chat history and "
        "return a STRICT JSON object. You do NOT write replies. Agent 2 "
        "handles that.\n\n"
        f"CHAT HISTORY:\n{history_str}\n\n"
        f"COLLECTED SO FAR (authoritative — do NOT contradict): {collected_str}\n\n"
        f"CUSTOMER LATEST MESSAGE: {state.cleaned_message!r}\n\n"
        "TASKS:\n"
        "  1. intent_type — what does the customer want RIGHT NOW? Pick "
        f"ONE of: {', '.join(ALLOWED_INTENTS)}.\n"
        "  2. detected_language — the language the customer is writing in. "
        f"Pick ONE of: {', '.join(['ary','ar','fr','en'])} "
        "(Darija in Arabizi or Arabic script both = 'ary').\n"
        "  3. customer_vibe — emotional/commercial state. Pick ONE of: "
        f"{', '.join(ALLOWED_VIBES)}.\n"
        "  4. extracted_fields — pull NEW values from the LATEST message "
        "ONLY. Do not echo values already in COLLECTED. Strip prefixes: "
        "'smiti X' → 'X', 'je m\\'appelle X' → 'X'. Quantity: 1-50 only.\n"
        "  5. lead_priority — pick ONE of: "
        f"{', '.join(ALLOWED_PRIORITIES)}. Hot = clear + responsive; "
        "Medium = needs nudging; Escalated = angry / refund / complex.\n\n"
        "OUTPUT FORMAT — JSON OBJECT, NO MARKDOWN FENCE, NO PREAMBLE:\n"
        "{\n"
        f"  \"intent_type\": \"<one of {ALLOWED_INTENTS}>\",\n"
        f"  \"detected_language\": \"<ary|ar|fr|en>\",\n"
        f"  \"customer_vibe\": \"<one of {ALLOWED_VIBES}>\",\n"
        f"{field_schema}\n"
        f"  \"lead_priority\": \"<one of {ALLOWED_PRIORITIES}>\"\n"
        "}\n"
    )


def _agent1_deterministic_fallback(state: ConversationState,
                                   detect_language_fn) -> Dict[str, Any]:
    """When BOTH LLM attempts return empty for Agent 1, we still need
    SOMETHING. Run pure regex/lookup extraction on the message so the
    pipeline can keep moving instead of falling back to a generic
    'wakha 3awd lia' message."""
    text = state.cleaned_message
    sniffed_lang = detect_language_fn(text) if text else ""
    out: Dict[str, Any] = {
        "intent_type": "product_purchase",
        "detected_language": sniffed_lang or "fr",
        "customer_vibe": "neutral",
        "extracted_fields": {},
        "lead_priority": "🟢 Hot Lead",
    }
    if not text:
        return out
    # Bare integer alone = quantity
    m = re.match(r"^\s*(\d{1,2})\s*$", text)
    if m:
        out["extracted_fields"]["quantity"] = int(m.group(1))
        return out
    # "smiti X" / "je m'appelle X" / "ana X"
    name = clean_name(text)
    if name and len(name) >= 2 and name[0].isalpha():
        out["extracted_fields"]["customer_name"] = name
    # City lookup hit anywhere in the message
    canon, matched = normalize_city(text)
    if matched:
        out["extracted_fields"]["city"] = canon
    return out


def _agent1_call(state: ConversationState,
                 kind: str,
                 recent_history: List[Dict],
                 llm_call_fn: Callable[[List[Dict], str, bool], Tuple[str, str]],
                 detect_language_fn) -> Dict[str, Any]:
    """Triple-tier fallback:
      1) Cheap model + response_format=json_object.
      2) On empty/stop → retry SAME model without response_format,
         parse JSON out of plain-text with the robust extractor.
      3) On still-empty → deterministic regex-only extraction.
    Returns the parsed dict (always non-empty thanks to tier 3)."""
    from brain import _extract_json_from_text  # local import to avoid cycle

    sys_prompt = _build_agent1_prompt(state, kind, recent_history)
    messages = [{"role": "system", "content": sys_prompt}]
    agent1_model = os.environ.get(AGENT1_MODEL_ENV, AGENT1_DEFAULT_MODEL)

    # Tier 1
    try:
        raw, finish = llm_call_fn(messages, agent1_model, True)
        if raw:
            parsed = _extract_json_from_text(raw)
            if parsed is not None:
                return _normalize_agent1_output(parsed, state.cleaned_message)
        log.info("[agents] Agent1 empty on tier 1 (model=%s finish=%s)",
                 agent1_model, finish)
    except Exception as exc:
        log.warning("[agents] Agent1 tier 1 exception: %s", exc)

    # Tier 2
    try:
        raw, finish = llm_call_fn(messages, agent1_model, False)
        if raw:
            parsed = _extract_json_from_text(raw)
            if parsed is not None:
                return _normalize_agent1_output(parsed, state.cleaned_message)
        log.info("[agents] Agent1 empty on tier 2 (model=%s finish=%s)",
                 agent1_model, finish)
    except Exception as exc:
        log.warning("[agents] Agent1 tier 2 exception: %s", exc)

    # Tier 3 — deterministic only
    log.warning("[agents] Agent1 falling back to deterministic extraction")
    return _agent1_deterministic_fallback(state, detect_language_fn)


def _normalize_agent1_output(raw: Dict[str, Any], message: str) -> Dict[str, Any]:
    """Coerce Agent 1's output into the enum-constrained shape we expect.
    Some models occasionally return labels in a sentence ('the intent
    is product_purchase'); we pick the first known label out."""
    def pick(value: Any, allowed: Tuple[str, ...], default: str) -> str:
        if not value:
            return default
        s = str(value).lower()
        # exact match (case-insensitive)
        for label in allowed:
            if label.lower() == s:
                return label
        # substring match
        for label in allowed:
            if label.lower() in s:
                return label
        return default

    intent = pick(raw.get("intent_type"), ALLOWED_INTENTS, "product_purchase")
    lang = (raw.get("detected_language") or "").lower().strip()
    if lang not in ("ary", "ar", "fr", "en"):
        lang = ""
    vibe = pick(raw.get("customer_vibe"), ALLOWED_VIBES, "neutral")
    priority = pick(raw.get("lead_priority"), ALLOWED_PRIORITIES,
                    "🟢 Hot Lead")

    fields_in = raw.get("extracted_fields") or {}
    fields_out: Dict[str, Any] = {}

    # name (Agent 1 calls it customer_name, brain calls it name)
    name = clean_name(fields_in.get("customer_name")
                      or fields_in.get("name"))
    if name:
        fields_out["name"] = name

    # city normalization
    city_raw = fields_in.get("city")
    city_matched = False
    if city_raw:
        canon, matched = normalize_city(str(city_raw))
        if canon:
            fields_out["city"] = canon
            city_matched = matched

    # address + incomplete flag
    addr = fields_in.get("address")
    address_incomplete = False
    if addr:
        fields_out["address"] = str(addr).strip()
        ok, _reason = address_completeness(fields_out["address"])
        if not ok:
            address_incomplete = True

    # quantity (with bound)
    qty = fields_in.get("quantity")
    if qty is not None:
        try:
            qi = int(qty)
            if 1 <= qi <= 50:
                fields_out["quantity"] = qi
        except (TypeError, ValueError):
            pass

    # service-specific free-text fields
    for k in ("booking_date", "duration", "requirements",
              "issue_details", "notes"):
        v = fields_in.get(k)
        if v and str(v).strip():
            # brain.py uses 'service_date'; Agent 1 spec calls it 'booking_date'
            target = "service_date" if k == "booking_date" else k
            fields_out[target] = str(v).strip()

    return {
        "intent_type": intent,
        "detected_language": lang,
        "customer_vibe": vibe,
        "extracted_fields": fields_out,
        "city_matched": city_matched,
        "address_incomplete": address_incomplete,
        "lead_priority": priority,
    }


# ════════════════════════════════════════════════════════════════════════
# AGENT 2 — Communicator / Closer
# ════════════════════════════════════════════════════════════════════════

_VIBE_GUIDANCE = {
    "worried_about_quality":
        "Briefly reassure the customer the product is 100% natural and "
        "we ship the authentic product. Don't over-explain.",
    "urgent":
        "Confirm delivery in 24-48h explicitly; match their energy.",
    "hesitant_on_price":
        "State the total upfront and mention free delivery + cash on "
        "delivery so there's no surprise.",
    "formal":
        "Match the formal tone (vous / Modern Standard Arabic). No "
        "emoji in the closing.",
    "angry":
        "Acknowledge the issue calmly. Do NOT push the sale. Offer to "
        "have a colleague call them back.",
    "enthusiastic":
        "Keep the warm energy — one emoji is fine in the close.",
    "neutral":
        "Standard concise close with one direct confirmation question.",
}


def build_closing_block(state: ConversationState,
                        kind: str,
                        product_name: str,
                        price_line: str) -> str:
    """The closing-mode addition to Agent 2's system prompt. Fires only
    when state.has_required(kind) is true."""
    vibe_hint = _VIBE_GUIDANCE.get(state.customer_vibe,
                                   _VIBE_GUIDANCE["neutral"])
    fields = state.collected_fields
    parts = []
    if fields.get("name"):       parts.append(f"name={fields['name']}")
    if kind == "service" and fields.get("service_date"):
        parts.append(f"date={fields['service_date']}")
    if fields.get("city"):       parts.append(f"city={fields['city']}")
    if fields.get("address"):    parts.append(f"address={fields['address']}")
    if kind != "service" and fields.get("quantity"):
        parts.append(f"qty={fields['quantity']}")

    return (
        "\n\n╔═══ CLOSING MODE (anti-repetition) ═══╗\n"
        "All required fields are collected. THIS is the final message.\n"
        f"COLLECTED: {', '.join(parts)}\n"
        f"PRODUCT/SERVICE: {product_name}\n"
        f"PRICE LINE: {price_line or '(no price set)'}\n"
        f"CUSTOMER VIBE: {state.customer_vibe}\n"
        f"VIBE GUIDANCE: {vibe_hint}\n"
        f"LEAD PRIORITY: {state.lead_priority}\n\n"
        "RULES (mandatory):\n"
        "  • Recap the order/booking in ONE clean line.\n"
        "  • Apply the VIBE GUIDANCE above — adapt the close to the\n"
        "    customer's state. NEVER write generic 'thank you for your\n"
        "    trust' / 'شكرا لثقتكم' / 'merci pour votre confiance' —\n"
        "    those are BANNED. Synthesize a unique sentence.\n"
        "  • End with ONE direct yes/no confirmation question.\n"
        "  • Max 240 characters total. One emoji max (zero if formal/angry).\n"
    )


# ════════════════════════════════════════════════════════════════════════
# ORCHESTRATION
# ════════════════════════════════════════════════════════════════════════

def run_agent1(
    *,
    seller_id: str,
    conversation_id: str,
    from_jid: str,
    phone: str,
    raw_text: str,
    pending_fields: Dict[str, Any],
    stored_language: str,
    detect_language_fn,
    llm_raw_call_fn: Callable[[List[Dict], str, bool], Tuple[str, str]],
    history: List[Dict],
    kind: str = "product",
) -> ConversationState:
    """Run Agent 1 end-to-end. Returns a ConversationState populated with
    intent/vibe/priority + normalized extracted fields ready to merge
    into pending_order_fields.

    `llm_raw_call_fn(messages, model, use_response_format) -> (raw_text,
    finish_reason)` is the brain-side hook. We pass it in to avoid an
    import cycle.
    """
    state = ConversationState(
        seller_id=seller_id,
        conversation_id=conversation_id,
        from_jid=from_jid,
        phone=phone,
        detected_language=stored_language or "",
        collected_fields=dict(pending_fields or {}),
        raw_message=raw_text or "",
    )
    state.cleaned_message = _clean_message(state.raw_message)

    parsed = _agent1_call(state, kind, history, llm_raw_call_fn,
                          detect_language_fn)

    state.intent_type = parsed.get("intent_type", "product_purchase")
    state.customer_vibe = parsed.get("customer_vibe", "neutral")
    state.lead_priority = parsed.get("lead_priority", "🟢 Hot Lead")
    state.city_matched = bool(parsed.get("city_matched"))
    state.address_incomplete = bool(parsed.get("address_incomplete"))

    # Pin language: stored wins; otherwise take Agent 1's detection.
    if not state.detected_language:
        lang = parsed.get("detected_language") or ""
        if lang:
            state.detected_language = lang
            state.note(f"lang pinned: {lang}")

    # Internal notes for the seller's Excel export. ALWAYS write at
    # least the vibe so the seller has signal even on calm turns —
    # otherwise the column is empty for happy customers and the seller
    # can't tell whether the bot ran the agent at all.
    state.note(f"vibe={state.customer_vibe}")
    if state.address_incomplete:
        state.note("address_incomplete=true")
    if parsed.get("extracted_fields", {}).get("city") and not state.city_matched:
        state.note(f"city '{parsed['extracted_fields']['city']}' not in alias list (review)")
    if state.intent_type != "product_purchase":
        state.note(f"intent={state.intent_type}")

    return state, parsed.get("extracted_fields", {})


__all__ = [
    "ConversationState",
    "ALLOWED_INTENTS", "ALLOWED_VIBES", "ALLOWED_PRIORITIES",
    "CITY_ALIASES", "normalize_city", "address_completeness", "clean_name",
    "run_agent1", "build_closing_block",
]
