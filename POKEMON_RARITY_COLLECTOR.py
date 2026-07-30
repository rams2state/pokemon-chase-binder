import csv
import json
import re
import time
import requests
import os
from datetime import date

API_KEY = "f05fdf49-6adf-440f-9022-2ed4dad15e45"
BASE_URL = "https://api.pokemontcg.io/v2/cards"

# ─── TCG API (api.tcgapi.dev) — pricing fallback for Mega Evolution series ──
# BUG FIX (2026-07-24): pokemontcg.io / TCGplayer pass-through returns zero
# price data for the entire "Mega Evolution" series (verified across all sets
# released Jan-July 2026: Ascended Heroes, Perfect Order, Chaos Rising, Pitch
# Black — every card has a bare tcgplayer.url with no `prices` block at all,
# even 6 months post-release). This is a structural gap, not a temporary lag —
# pokemontcg.io is being sunset in favor of the paid Scrydex successor, and new
# 2026-era sets are falling into that maintenance gap. Rather than call
# pokemontcg.io daily for these cards and reliably get nothing back, we skip
# straight to TCG API (api.tcgapi.dev), confirmed via manual testing to have
# real, current, USD market prices for these exact sets.
TCG_API_KEY = "tcg_live_79158159f19e7e23df8e5bc3afc5c4f95e9949b4"
TCG_API_BASE = "https://api.tcgapi.dev/v1"

# pokemontcg.io set.id -> TCG API set_id, for every Mega Evolution series set.
# Add new ME sets here as they release (check via the TCG API /v1/sets?q=ME
# lookup) — pokemontcg.io coverage of this series is expected to stay broken.
MEGA_EVOLUTION_SET_IDS = {
    # Confirmed against the live pokemontcg.io /v2/sets endpoint (2026-07-24).
    "me1":    5500179,  # ME01: Mega Evolution
    "me2":    5500152,  # ME02: Phantasmal Flames
    "me2pt5": 5500112,  # ME: Ascended Heroes
    "me3":    5500047,  # ME03: Perfect Order
    "me4":    5500213,  # ME04: Chaos Rising
    "me5":    5500216,  # ME05: Pitch Black
    # NOTE: "ME: Mega Evolution Promo" and "ME: Mega Evolution Energies" exist
    # on TCG API but were NOT found under those names on pokemontcg.io's
    # /v2/sets endpoint — they may be excluded/named differently there. Since
    # compiled_cards only ever contains pokemontcg.io set.id values, these two
    # can't match anyway; add them here only if you confirm the real
    # pokemontcg.io set.id for them later.
}

# ─── Vintage sets with partial pokemontcg.io price gaps ─────────────────────
# BUG FOUND (2026-07-27): within the Aquapolis and Skyridge Crystal/Holo
# secret-rare "H" subsets (H1-H32 in each set), pokemontcg.io/TCGplayer has
# price data for most cards but is missing a handful (confirmed: H1-H9 in
# both sets, plus H15 in Aquapolis — card records themselves fetch fine, e.g.
# "ecard2-H1"/"ecard2-H15" resolve, only the price is missing). This is a
# TCGplayer market-data gap for these specific cards, not a script bug —
# verified via TCG API (api.tcgapi.dev) that real market prices exist there
# (Aquapolis/Skyridge H-cards mostly priced except Skyridge Gengar H9, which
# has zero TCGplayer listings anywhere — a genuine, separate, unfixable gap).
#
# NOTE: variable name kept as VINTAGE_ECARD_SET_IDS for historical reasons
# (originally only Aquapolis/Skyridge) but patch_vintage_ecard_prices() /
# patch_vintage_ecard_fallback_rows() are fully generic — they patch ANY
# card missing a price in ANY set listed here, regardless of set era or
# naming convention. Add more sets here ONLY if the TCG API set uses ONE
# consistent denominator throughout (see PINNED_PRICE_OVERRIDES below for
# why bundled multi-denominator promo sets can't safely use this mechanism).
#
# pokemontcg.io set.id -> TCG API set_id, confirmed via /v1/sets?game=pokemon
# lookup (2026-07-27).
VINTAGE_ECARD_SET_IDS = {
    "ecard2": 5500011,  # Aquapolis
    "ecard3": 5500160,  # Skyridge
}

# ─── Manually-pinned price overrides ────────────────────────────────────────
# BUG FOUND (2026-07-27): Wizards Black Star Promos (pokemontcg.io "basep")
# was initially added to VINTAGE_ECARD_SET_IDS to backfill Pikachu #1 and
# Smeargle #32 (both missing a pokemontcg.io price) via TCG API's "WoTC
# Promo" set (set_id 5500162) — but that TCG API set bundles MULTIPLE
# distinct promo sub-series with DIFFERENT denominators (/53, /62, /64, /82,
# etc.) under one set_id. Stripping the denominator to match pokemontcg.io's
# bare numerator collapsed unrelated cards onto the same key — e.g. "Pikachu
# (1) 01/53" and "Clefable (Prerelease) 01/64" both normalize to "1" — and
# the old dedup logic silently picked whichever had the higher price,
# producing a WRONG price (Pikachu showed Clefable's $999.95 instead of its
# own $37.49). fetch_tcg_api_prices_for_set() now detects this ambiguity and
# drops those numbers entirely rather than guess (correct, but means basep
# can no longer auto-patch via that mechanism at all).
#
# Since these two specific prices were independently confirmed correct via a
# direct TCG API card-level check (not the ambiguous set-level fetch), they're
# manually pinned here instead. Unlike VINTAGE_ECARD_SET_IDS patches, these
# are static and won't auto-update if the real market price changes — revisit
# if TCG API ever exposes per-card lookup that avoids the bundling issue.
PINNED_PRICE_OVERRIDES = {
    "basep-1":  37.49,   # Pikachu (Wizards Black Star Promos) — confirmed via
                         # TCG API card id 26071 (number "01/53"), 2026-07-27.
    "basep-32": 15.11,   # Smeargle (Wizards Black Star Promos) — confirmed via
                         # TCG API (number "32/53"), 2026-07-27.
}

# Set True mid-run if TCG API reports its daily quota is exhausted (free
# tier: 100 requests/day). Once True, patch_mega_evolution_prices() stops
# trying further sets this run instead of burning failed calls on each one —
# cards not yet patched simply keep whatever price they had (blank, or
# preserved from yesterday's CSV via the existing fallback logic). Resets
# naturally next run since this is a plain module-level flag, not persisted.
TCG_API_QUOTA_EXHAUSTED = False

# Save to the Pokemon project folder
PROJECT_DIR = os.path.join(os.path.expanduser("~"), "Claude", "Pokemon")
OUTPUT_FILE = os.path.join(PROJECT_DIR, "POKEMON_RARITY_COLLECTION.csv")
HISTORY_FILE = os.path.join(PROJECT_DIR, "card-price-history.json")

# ─── RARITY PHILOSOPHY ───────────────────────────────────────────────────────
# We target the RAREST and most historically significant pulls of each era.
# This means:
#
#   SCARLET & VIOLET ERA:
#     - Mega Hyper Rare (~1:1260)       — apex SV pull, rarest in modern TCG history
#     - Special Illustration Rare (~1:72-86) — SIR/SAR, the painterly full-bleed chase tier
#     - Illustration Rare (~1:10-12)    — IR, full-art borderless; included for artistic legacy
#     - ACE SPEC Rare                   — 1-per-deck mechanic; low pull rate, high demand
#     - Double Rare (select IDs only)   — Charizard ex OBF, Pikachu ex SSP; most DR ex are bulk
#
#   SWORD & SHIELD ERA:
#     - Hyper Rare (Rainbow Rare)       — rarest single-card pull in SWSH sets
#     - Trainer Gallery Rare Holo       — hidden subset; V, VMAX, and Holo sub-tiers
#     - Amazing Rare                    — unique lightning/rainbow art; Vivid Voltage & beyond
#     - Rare Shiny / Rare Shiny GX      — Shiny Vault (Hidden Fates, Shining Fates)
#     - Radiant Rare                    — 1-per-deck mechanic; Radiant Charizard/Greninja tier
#
#   SUN & MOON ERA:
#     - Rare Rainbow                    — SM Rainbow Rare (distinct rarity string from SWSH Hyper Rare)
#     - Rare Ultra                      — Full Art GX / Tag Team GX / Supporter Full Arts
#     - Rare Shiny GX                   — Shiny Vault GX pulls (Hidden Fates)
#
#   BLACK & WHITE / XY ERA:
#     - Rare Secret                     — Gold-border Secret Rares (Items, Supporters, Pokémon)
#     - Rare Ultra                      — Full Art Pokémon-EX, Full Art Supporters (BW/XY)
#     - Rare Rainbow                    — XY-era Rainbow/Hyper equivalent where applicable
#
#   DIAMOND & PEARL / HGSS ERA:
#     - LEGEND (subtype)                — dual-card pairs; both halves required
#     - LV.X (subtype)                  — pack-pulled and tin promo; tracked together
#     - Rare Prime                      — HGSS silver-border chase rares
#     - Rare Holo Star                  — DP-era shiny star treatment (Pikachu ★, etc.)
#
#   EX ERA (2003-2007):
#     - Gold Star (subtype)             — ~1:72 packs; rarest EX era cards ever printed
#     - Crystal (subtype)               — Aquapolis/Skyridge; ~1:36 packs; holy grail vintage
#
#   NEO ERA (2000-2002):
#     - Rare Shining                    — Shining Charizard / Mewtwo / Tyranitar tier
#
#   VINTAGE BASE THROUGH E-CARD (1998-2003):
#     - Rare Holo (scoped by series)    — THE chase card of each vintage set
#     - WotC Black Star Promos          — series:"Base" + set name "Wizards Black Star Promos"
#
# Trainer card note: Rare Ultra and Rare Secret queries include Trainers intentionally —
# Full Art N, Full Art Lysandre, and Supporter SIRs (Iono, etc.) are legitimate high-end
# chase targets. Filter by supertype in your UI if desired.
#
# Rare BREAK (XY era): excluded — too common and low collectible value.
# Rare ACE (older): excluded — not to be confused with ACE SPEC Rare (SV).

QUERIES = [
    # ══════════════════════════════════════════════════════════════════════════
    # SCARLET & VIOLET ERA
    # ══════════════════════════════════════════════════════════════════════════

    # Mega Hyper Rare: ~1:1260 packs — rarest cards in modern TCG history
    'rarity:"Mega Hyper Rare"',

    # Mega Attack Rare: SV era secret-numbered chase tier (Ascended Heroes onward)
    # Numbered beyond set total; strong market demand — Charizard, Pikachu, Gengar tier
    # API rarity string is "MEGA_ATTACK_RARE" (all caps with underscores)
    'rarity:MEGA_ATTACK_RARE',

    # Special Illustration Rare (SIR/SAR): ~1:72-86 packs — full-bleed painterly apex tier
    'rarity:"Special Illustration Rare"',

    # Illustration Rare (IR): ~1:10-12 packs — borderless full-art; included for artistic/legacy value
    'rarity:"Illustration Rare"',

    # ACE SPEC Rare: 1-per-deck mechanic reintroduced in SV; low pull rate, real market demand
    # Master Ball, Prime Catcher, Unfair Stamp sit $30-50+. SIR variants also captured by SIR query.
    'rarity:"ACE SPEC Rare"',

    # Double Rare: NOT queried by rarity — produces too much bulk noise.
    # Only the specific cards with genuine collector value are fetched by card ID.
    # All IDs verified against the pokemontcg.io API (July 2026).
    # Most Double Rare ex cards sit $1-6 market — only iconic/high-demand exceptions included.
    'id:"sv3-125"',  # Charizard ex (Obsidian Flames) — Tera Dark variant; confirmed DR, $5-6
    # sv8-57 removed: Pikachu ex (Surging Sparks) DR sits ~$4 market — not chase tier
    # sv1-* IDs removed: all were wrong (API IDs don't match expected cards)
    # sv3-223 removed: confirmed SIR, already captured by SIR query above
    # sv5-30 removed: card not found in API
    # Terapagos ex DR (sv7-128): $0.68 market — excluded, not chase tier
    # SIR/MHR versions of all other notable ex Pokémon covered by rarity queries above

    # ══════════════════════════════════════════════════════════════════════════
    # SWORD & SHIELD ERA
    # ══════════════════════════════════════════════════════════════════════════

    # Hyper Rare (Rainbow Rare): rarest single-card pull in SWSH sets
    'rarity:"Hyper Rare"',

    # Rare Secret: gold-border Secret Rares in main SWSH numbered sets that are
    # NOT Hyper Rare and NOT in a Trainer/Galarian Gallery subset (those are
    # covered by set.id queries below) — e.g. gold Energy/Trainer secret rares
    # in sets like Vivid Voltage, Battle Styles, Chilling Reign.
    'rarity:"Rare Secret" set.series:"Sword & Shield"',

    # Trainer Gallery sets — queried by set ID to capture all rarity tiers:
    # TG01–TG14: Trainer Gallery Rare Holo (Holo Pokémon + Supporters)
    # TG15–TG27: Rare Holo VMAX / Rare Holo V (VMAX/V tier)
    # TG28–TG30: Rare Secret (apex VMAX pulls)
    # Querying by rarity:"Trainer Gallery Rare Holo" only catches TG01–TG14
    'set.id:swsh9tg',   # Brilliant Stars Trainer Gallery (30 cards)
    'set.id:swsh10tg',  # Astral Radiance Trainer Gallery (30 cards)
    'set.id:swsh11tg',  # Lost Origin Trainer Gallery (30 cards)
    'set.id:swsh12tg',  # Silver Tempest Trainer Gallery (30 cards)

    # Crown Zenith Galarian Gallery — all 70 cards by set ID
    # GG01–GG34: Trainer Gallery Rare Holo (caught above but deduplicated)
    # GG35–GG66: Rare Holo VSTAR / Rare Ultra (VSTAR, V, Full Art Supporters)
    # GG67–GG70: Rare Secret (Palkia, Dialga, Giratina, Arceus VSTAR apex pulls $130–$387)
    # Every card in this set is a gallery chase card — simplest to pull the whole set
    'set.id:swsh12pt5gg',

    # Amazing Rare: unique lightning/rainbow art treatment; Vivid Voltage, Evolving Skies, etc.
    # Jirachi, Zacian, Rayquaza among top targets
    'rarity:"Amazing Rare" supertype:"Pokémon"',

    # Hidden Fates / Shining Fates Shiny Vaults — queried by set ID to get all cards:
    # Rare Shiny (SV1–SV94 / SV001–SV122): non-GX shinies (shiny Eevee, Pikachu, etc.)
    # Rare Shiny GX (SV49+ / SV065+): GX apex pulls (shiny Charizard-GX, Mewtwo-GX, etc.)
    # All cards in these sets are chase-worthy — shiny vault is the whole point
    'set.id:sma',       # Hidden Fates Shiny Vault (94 cards)
    'set.id:swsh45sv',  # Shining Fates Shiny Vault (122 cards)

    # Radiant Rare: 1-per-deck mechanic; Radiant Charizard / Greninja tier
    'rarity:"Radiant Rare" supertype:"Pokémon"',

    # Radiant Eevee promo — SWSH Black Star Promo SWSH230; packaged in the
    # Pokémon GO Premium Collection—Radiant Eevee box (July 1 2022).
    # Not in the main pgo set; must be fetched by specific card ID.
    'id:"swshp-SWSH230"',

    # ══════════════════════════════════════════════════════════════════════════
    # SUN & MOON ERA
    # ══════════════════════════════════════════════════════════════════════════

    # Rare Rainbow: SM-era Rainbow Rare (distinct API rarity string from SWSH Hyper Rare)
    # Includes Rainbow Rare GX and Tag Team GX variants
    'rarity:"Rare Rainbow" supertype:"Pokémon"',

    # Rare Ultra: Full Art GX, Full Art Tag Team GX, Full Art Supporters
    # SM-era full-art treatment — covers Trainer Full Arts as well (intentional)
    'rarity:"Rare Ultra" set.series:"Sun"',

    # Rare Secret: gold-border non-holo Secret Rares in SM sets that are NOT
    # Rainbow or Ultra (e.g. Piplup (Secret), Cosmic Eclipse SM12) — these use
    # the plain "Rare Secret" rarity string and were missed by the queries above.
    'rarity:"Rare Secret" set.series:"Sun & Moon"',

    # ══════════════════════════════════════════════════════════════════════════
    # BLACK & WHITE / XY ERA
    # ══════════════════════════════════════════════════════════════════════════

    # Rare Secret: gold-border Secret Rares — Items, Supporters, Pokémon (BW/XY/SM)
    # Scoped here to BW+XY; SM Rare Secret captured by SM Rare Ultra / Rare Rainbow above
    'rarity:"Rare Secret" set.series:"Black & White"',
    'rarity:"Rare Secret" set.series:"XY"',

    # Rare Ultra: Full Art Pokémon-EX, Mega EX Full Arts, Full Art Supporters (BW/XY)
    # Genesis of the modern Full Art chase mechanic
    'rarity:"Rare Ultra" set.series:"Black & White"',
    'rarity:"Rare Ultra" set.series:"XY"',

    # ══════════════════════════════════════════════════════════════════════════
    # DIAMOND & PEARL / PLATINUM / HGSS ERA
    # ══════════════════════════════════════════════════════════════════════════

    # LEGEND: dual-card pairs from HGSS (Lugia LEGEND, Ho-Oh LEGEND, etc.)
    # Both halves pulled independently — tracked together, separated in UI by card number
    'subtypes:"LEGEND" supertype:"Pokémon"',

    # LV.X: top-tier chase pulls from Diamond & Pearl and Platinum era
    # BUG FIX (2026-07-24): API subtype is "Level-Up", not "LV.X" — "LV.X" only appears
    # in the card name. The old subtypes:"LV.X" query always matched 0 cards, so no
    # LV.X card has ever been fetched. Querying by rarity instead (API rarity string
    # for set-pulled LV.X cards is "Rare Holo LV.X", already in ALLOWED_RARITIES).
    'rarity:"Rare Holo LV.X" supertype:"Pokémon"',

    # Rare Prime: HGSS silver-border chase rares (Espeon, Umbreon, Gengar, Celebi Prime)
    'rarity:"Rare Prime" supertype:"Pokémon"',

    # Rare Holo Star: DP-era shiny/star treatment (Pikachu ★, Charizard ★, etc.)
    'rarity:"Rare Holo Star" supertype:"Pokémon"',

    # Rare Secret: DP/HGSS-era Secret Rares (e.g., Lv.X Stormfront Secret, Legend Box pulls)
    'rarity:"Rare Secret" set.series:"Diamond & Pearl"',
    'rarity:"Rare Secret" set.series:"Platinum"',
    'rarity:"Rare Secret" set.series:"HeartGold & SoulSilver"',

    # Call of Legends Shiny Legends (SL rarity) — captured under Rare Holo Star via API;
    # explicitly scoped here to ensure full set coverage
    'rarity:"Rare Holo Star" set.series:"HeartGold & SoulSilver"',

    # Rare Holo (DP/Platinum/HGSS): EXCLUDED per finalized criteria.
    # Chase tiers for this era are LEGEND, LV.X, Rare Prime, and Rare Holo Star only.
    # Standard Rare Holos from DP/HGSS are not tracked.

    # ══════════════════════════════════════════════════════════════════════════
    # EX SERIES ERA (2003–2007)
    # ══════════════════════════════════════════════════════════════════════════

    # Gold Star: ~1:72 packs — rarest EX era cards ever printed
    # Charizard ★, Rayquaza ★, Umbreon ★, Espeon ★, Pikachu ★ are apex targets
    'subtypes:"Gold Star" supertype:"Pokémon"',

    # Crystal type: Aquapolis/Skyridge ~1:36 packs — holy grail vintage cards
    # Crystal Charizard, Crystal Lugia, Crystal Ho-Oh
    'subtypes:"Crystal" supertype:"Pokémon"',

    # EX-era Secret Rares: gold-border cards from EX sets (Deoxys, Delta Species, etc.)
    'rarity:"Rare Secret" set.series:"EX"',

    # Rare Holo (EX era): scoped to EX series — Skyridge/Aquapolis holos have tiny print runs
    # Skyridge Charizard, Aquapolis Espeon/Umbreon are top-5 English cards by PSA scarcity
    'rarity:"Rare Holo" set.series:"EX" supertype:"Pokémon"',

    # ══════════════════════════════════════════════════════════════════════════
    # NEO ERA (2000–2002)
    # ══════════════════════════════════════════════════════════════════════════

    # Rare Shining: Shining Charizard / Mewtwo / Tyranitar — neo-era holy grails
    # First multi-color holofoil treatment in the TCG; appears in Neo Revelation & Neo Destiny
    'rarity:"Rare Shining" supertype:"Pokémon"',

    # ══════════════════════════════════════════════════════════════════════════
    # VINTAGE BASE THROUGH E-CARD (1998–2003)
    # ══════════════════════════════════════════════════════════════════════════

    # Rare Holo: THE chase card of each vintage set — Charizard, Blastoise, Venusaur tier
    # Scoped by series to avoid pulling modern Rare Holos from later sets
    'rarity:"Rare Holo" set.series:"Base" supertype:"Pokémon"',
    'rarity:"Rare Holo" set.series:"Gym" supertype:"Pokémon"',
    'rarity:"Rare Holo" set.series:"Neo" supertype:"Pokémon"',
    'rarity:"Rare Holo" set.series:"Legendary" supertype:"Pokémon"',
    'rarity:"Rare Holo" set.series:"E-Card" supertype:"Pokémon"',

    # ══════════════════════════════════════════════════════════════════════════
    # VINTAGE SECRET RARES (cards numbered beyond set total)
    # ══════════════════════════════════════════════════════════════════════════

    # Covers Dark Raichu (#83/82 Team Rocket), Gym Heroes/Challenge Secrets,
    # Neo Destiny Secrets, e-Card Secrets
    # Legendary Collection excluded entirely — all cards are reprints with no chase value
    'rarity:"Rare Secret" set.series:"Base"',
    'rarity:"Rare Secret" set.series:"Gym"',
    'rarity:"Rare Secret" set.series:"Neo"',
    'rarity:"Rare Secret" set.series:"E-Card"',

    # WotC Black Star Promos: numbered promo series (001–053)
    # Ancient Mew, Birthday Pikachu, Red Cheeks Pikachu (#4) are apex targets
    # Scoped to the "Wizards Black Star Promos" set within the Base series
    'set.name:"Wizards Black Star Promos"',

    # ══════════════════════════════════════════════════════════════════════════
    # PALDEAN FATES — SHINY PULLS (SV era shiny set, 2024)
    # ══════════════════════════════════════════════════════════════════════════

    # Shiny Rare: shiny-variant Pokémon pulls in Paldean Fates (non-ex shinies)
    'rarity:"Shiny Rare" set.name:"Paldean Fates"',

    # Shiny Ultra Rare: shiny Pokémon ex pulls — the apex Paldean Fates targets
    # Shiny Charizard ex, Shiny Umbreon ex, Shiny Miraidon ex, Shiny Koraidon ex
    'rarity:"Shiny Ultra Rare" set.name:"Paldean Fates"',

    # ══════════════════════════════════════════════════════════════════════════
    # XY BLACK STAR PROMOS — HIGH-VALUE SHINY MEGAS (by card ID)
    # ══════════════════════════════════════════════════════════════════════════

    # Not queried by rarity — pulled by specific ID to avoid the entire
    # XY promo set flooding the list. These are the only XY promos with
    # genuine top-tier collector value.
    'id:"xyp-XY172"',   # Shiny Mega Gardevoir-EX — top-5 XY era chase card
    'id:"xyp-XY173"',   # Shiny Mega Gyarados-EX — top-5 XY era chase card
    'id:"xyp-XY174"',   # Shiny Mega Metagross-EX
    'id:"xyp-XY175"',   # Shiny Mega Gengar-EX
    'id:"xyp-XY176"',   # Shiny Mega Rayquaza-EX — arguably the most iconic XY promo

    # Crown Zenith main set — Pikachu Secret Rare (#160, beyond printed total of 159)
    'id:"swsh12pt5-160"',  # Pikachu Secret Rare — $46, only chase card beyond the Radiants
]


def fetch_cards_by_query(query_string, api_key):
    """Fetches all cards for a query, handling pagination and rate limits."""
    headers = {"X-Api-Key": api_key}
    all_cards = []
    page = 1
    page_size = 250

    print(f"\nFetching: {query_string}")

    while True:
        params = {"q": query_string, "page": page, "pageSize": page_size}
        retries = 3
        success = False
        cards_batch = []
        total_count = 0

        while retries > 0:
            try:
                response = requests.get(BASE_URL, headers=headers, params=params, timeout=60)

                if response.status_code == 429:
                    print("  Rate limited. Waiting 15s...")
                    time.sleep(15)
                    retries -= 1
                    continue

                response.raise_for_status()
                data = response.json()
                cards_batch = data.get("data", [])
                total_count = data.get("totalCount", 0)
                success = True
                break

            except requests.exceptions.RequestException as e:
                retries -= 1
                print(f"  Page {page} error (retries left: {retries}): {e}")
                time.sleep(5)

        if not success:
            print(f"  Skipping remaining pages due to persistent errors.")
            break

        if not cards_batch:
            break

        all_cards.extend(cards_batch)
        print(f"  Page {page}: {len(cards_batch)} cards (total so far: {len(all_cards)}/{total_count})")

        if len(all_cards) >= total_count:
            break

        page += 1
        time.sleep(0.5)

    return all_cards


def parse_card_price(card_data):
    """Extracts the best available market price. Returns (float_or_None, '$X.XX' or 'N/A')."""
    tcg_prices = card_data.get("tcgplayer", {}).get("prices", {})
    if not tcg_prices:
        return None, "N/A"

    # Priority order — 1st Edition first for Base Series cards
    price_types = ["1stEditionHolofoil", "holofoil", "reverseHolofoil", "normal"]
    # Pass 1: try market price across known types
    for p_type in price_types:
        if p_type in tcg_prices:
            market_val = tcg_prices[p_type].get("market")
            if market_val:
                return round(float(market_val), 2), f"${market_val:.2f}"

    # Pass 2: try ALL available price types for market price
    for p_type, prices in tcg_prices.items():
        market_val = prices.get("market")
        if market_val:
            return round(float(market_val), 2), f"${market_val:.2f}"

    # Pass 3: fall back to mid price across all types
    for p_type, prices in tcg_prices.items():
        mid_val = prices.get("mid")
        if mid_val:
            return round(float(mid_val), 2), f"${mid_val:.2f}"

    return None, "N/A"


def normalize_tcg_api_number(raw_number):
    """Normalizes a TCG API card number to match pokemontcg.io's format.

    TCG API returns the full, zero-padded fraction, e.g. "021/088" (plain
    numeric sets like Mega Evolution) or "H01/H32" (alpha-prefixed secret
    rares like Aquapolis/Skyridge's "H" subset). pokemontcg.io stores only
    the numerator, WITHOUT zero-padding and WITHOUT re-padding the prefix —
    e.g. "21" (not "021") or "H1" (not "H01"). Strip the denominator, then
    strip leading zeros from the numeric portion only (any alpha prefix like
    "H" is preserved as-is, since lstrip("0") alone would no-op on it).
    """
    numerator = raw_number.split("/")[0].strip()
    m = re.match(r"^([A-Za-z]*)0*(\d+)$", numerator)
    if not m:
        return numerator or "0"
    prefix, digits = m.groups()
    return f"{prefix}{digits}" if (prefix or digits) else "0"


def fetch_tcg_api_prices_for_set(tcg_api_set_id):
    """Fetch all card prices for one TCG API set_id, keyed by card number.

    Returns {"284": {"market": 1273.24, "printing": "Holofoil"}, ...}

    Uses GET /v1/sets/:id/cards — the real "list every card in this set"
    endpoint (confirmed via manual testing: returns all cards including
    sealed products in one response, no query-matching workaround needed).
    Earlier draft used /v1/search with a dummy query string, but /search
    requires a real substring match against card names and can't guarantee
    full-set coverage (e.g. Supporter/Trainer cards with unusual names) —
    /sets/:id/cards has no such gap since it lists by set membership, not text.
    """
    headers = {"X-API-Key": TCG_API_KEY}
    prices_by_number = {}
    denominators_by_number = {}  # number -> set of distinct raw denominators seen
    page = 1
    per_page = 100

    retries_left = 3
    while True:
        params = {"page": page, "per_page": per_page}
        try:
            resp = requests.get(
                f"{TCG_API_BASE}/sets/{tcg_api_set_id}/cards",
                headers=headers, params=params, timeout=30,
            )
            if resp.status_code == 429:
                # 429 covers BOTH per-minute rate limiting AND the daily quota
                # being exhausted — same status code, distinguished only by
                # the error body. Daily limit resets at midnight UTC, so
                # retrying won't help; per-minute limiting is worth a short
                # wait. Check the error code and bail immediately + cleanly
                # if it's the daily cap, rather than sleep-looping forever.
                try:
                    err_code = resp.json().get("error", {}).get("code", "")
                except Exception:
                    err_code = ""

                if err_code == "RATE_LIMIT_EXCEEDED" or "daily" in resp.text.lower():
                    print(f"  TCG API daily quota exhausted (set {tcg_api_set_id}, "
                          f"page {page}). Resets at midnight UTC — skipping "
                          f"remaining TCG API pricing for this run.")
                    global TCG_API_QUOTA_EXHAUSTED
                    TCG_API_QUOTA_EXHAUSTED = True
                    return prices_by_number

                retries_left -= 1
                if retries_left <= 0:
                    print(f"  TCG API still rate limited after retries "
                          f"(set {tcg_api_set_id}, page {page}). Skipping.")
                    break
                print(f"  TCG API rate limited. Waiting 15s... "
                      f"({retries_left} retries left)")
                time.sleep(15)
                continue
            resp.raise_for_status()
            data = resp.json()
        except requests.exceptions.RequestException as e:
            print(f"  TCG API error (set {tcg_api_set_id}, page {page}): {e}")
            break

        results = data.get("data", [])
        for card in results:
            # Sealed products (boxes, ETBs, etc.) have number == null — skip,
            # we only want singles.
            raw_number = card.get("number")
            if not raw_number:
                continue
            # See normalize_tcg_api_number() docstring — handles both plain
            # numeric ("021/088" -> "21") and alpha-prefixed ("H01/H32" ->
            # "H1") TCG API number formats to match pokemontcg.io's.
            number = normalize_tcg_api_number(raw_number)
            market_price = card.get("market_price")
            if not number or not market_price:
                continue

            # BUG FIX (2026-07-27): some TCG API "sets" bundle multiple
            # distinct sub-series with DIFFERENT denominators under one
            # set_id (confirmed: WoTC Promo mixes /53, /62, /64, /82, etc.).
            # Stripping the denominator to match pokemontcg.io's bare
            # numerator can then collapse totally unrelated cards onto the
            # same key — e.g. "Pikachu (1) 01/53" and "Clefable
            # (Prerelease) 01/64" both normalize to "1". The old "keep
            # highest price" dedup silently picked whichever card had the
            # higher price, which produced wrong prices (confirmed: Pikachu
            # #1 got Clefable's $999.95 instead of its own $37.49).
            #
            # Fix: track every DISTINCT raw denominator seen for a given
            # normalized number. If more than one distinct denominator shows
            # up, the numerator is ambiguous in this set — we can't tell
            # which card pokemontcg.io's bare number actually refers to, so
            # drop it entirely rather than guess. Sets with one consistent
            # denominator throughout (Aquapolis, Skyridge, all ME sets) are
            # completely unaffected — every card in a real single-denominator
            # set only ever contributes one denominator per numerator anyway.
            denominator = raw_number.split("/", 1)[1].strip() if "/" in raw_number else ""
            seen_denoms = denominators_by_number.setdefault(number, set())
            seen_denoms.add(denominator)

            existing = prices_by_number.get(number)
            if existing is None or market_price > existing["market"]:
                prices_by_number[number] = {
                    "market": market_price,
                    "printing": card.get("printing", "Holofoil"),
                }

        total_count = data.get("meta", {}).get("total", 0)
        print(f"    TCG API page {page}: {len(results)} cards "
              f"(total so far: {min(page * per_page, total_count)}/{total_count})")

        if not data.get("meta", {}).get("has_more"):
            break
        page += 1
        time.sleep(0.3)

    # Drop any numerator that mapped to more than one distinct denominator —
    # ambiguous across sub-series within this TCG API set, can't safely match
    # against pokemontcg.io's bare (denominator-less) number. See BUG FIX note
    # above for the confirmed real-world collision that motivated this.
    ambiguous = [n for n, denoms in denominators_by_number.items() if len(denoms) > 1]
    for number in ambiguous:
        del prices_by_number[number]
    if ambiguous:
        print(f"    Skipped {len(ambiguous)} ambiguous number(s) (multiple "
              f"denominators map to the same bare number in this set): "
              f"{', '.join(sorted(ambiguous))}")

    return prices_by_number


def patch_mega_evolution_prices(compiled_cards):
    """Backfill prices for Mega Evolution series cards via TCG API.

    pokemontcg.io / TCGplayer pass-through has no price data for this entire
    series (confirmed structural, not a temporary lag — see comment near
    MEGA_EVOLUTION_SET_IDS). Rather than call pokemontcg.io for these cards
    and reliably get nothing, we patch a synthetic tcgplayer.prices.holofoil
    block onto each affected card in-place so parse_card_price() picks it up
    exactly like a normal pokemontcg.io response downstream — no changes
    needed anywhere else in the script.

    Returns {pokemontcg_set_id: prices_by_number, ...} for every set actually
    queried this run, so main() can reuse the same fetched prices to also
    patch fallback rows (cards preserved from yesterday's CSV because
    pokemontcg.io's OWN card-data fetch failed today — those never pass
    through compiled_cards at all, so without this they'd stay stuck at
    whatever price they had before, which is N/A for any Mega Evolution
    card that's never had a successful pokemontcg.io price in the first
    place). See BUG FIX note at the call site in main() for the full story.
    """
    # Group affected cards by their pokemontcg.io set.id
    cards_by_set = {}
    for card in compiled_cards:
        set_id = card.get("set", {}).get("id", "")
        if set_id in MEGA_EVOLUTION_SET_IDS:
            cards_by_set.setdefault(set_id, []).append(card)

    if not cards_by_set:
        return {}

    print(f"\nPatching prices via TCG API for Mega Evolution series "
          f"({sum(len(v) for v in cards_by_set.values())} cards, "
          f"{len(cards_by_set)} set(s))...")

    global TCG_API_QUOTA_EXHAUSTED
    sets_skipped = []
    fetched_prices_by_set = {}

    for set_id, cards in cards_by_set.items():
        if TCG_API_QUOTA_EXHAUSTED:
            # Daily quota already confirmed exhausted earlier this run —
            # don't waste calls confirming it again on every remaining set.
            sets_skipped.append(set_id)
            continue

        tcg_api_set_id = MEGA_EVOLUTION_SET_IDS[set_id]
        print(f"  {set_id} -> TCG API set_id {tcg_api_set_id} ({len(cards)} cards)")
        prices_by_number = fetch_tcg_api_prices_for_set(tcg_api_set_id)
        fetched_prices_by_set[set_id] = prices_by_number

        patched = 0
        for card in cards:
            # Normalize the same way as fetch_tcg_api_prices_for_set() so a
            # stray leading zero or whitespace can't cause a silent miss.
            raw_number = card.get("number") or ""
            number = raw_number.strip().lstrip("0") or "0"
            price_info = prices_by_number.get(number)
            if price_info:
                printing_key = "holofoil" if "foil" in price_info["printing"].lower() else "normal"
                card["tcgplayer"] = card.get("tcgplayer", {})
                card["tcgplayer"]["prices"] = {
                    printing_key: {"market": price_info["market"]}
                }
                patched += 1

        print(f"    -> {patched}/{len(cards)} cards priced from TCG API")

    if sets_skipped:
        skipped_card_count = sum(len(cards_by_set[s]) for s in sets_skipped)
        print(f"  Skipped {len(sets_skipped)} set(s) ({', '.join(sets_skipped)}, "
              f"{skipped_card_count} cards) — TCG API daily quota exhausted. "
              f"These cards keep their existing price (blank or preserved "
              f"from yesterday's CSV) until the quota resets and a future "
              f"run can retry them.")

    return fetched_prices_by_set


def patch_mega_evolution_fallback_rows(missing_ids, existing_rows, fetched_prices_by_set, today):
    """Apply TCG API prices to Mega Evolution cards preserved via fallback.

    BUG FIX (2026-07-24): patch_mega_evolution_prices() only ever patches
    cards inside compiled_cards — i.e. cards pokemontcg.io's OWN fetch
    succeeded on this run. Any Mega Evolution card whose pokemontcg.io fetch
    failed today (common given ongoing 500s) gets preserved from yesterday's
    raw CSV row instead, completely bypassing the TCG API patch — and since
    pokemontcg.io has never had real prices for this series, that preserved
    row's Price column is permanently stuck at "N/A" until pokemontcg.io
    happens to succeed on a future run. Confirmed in practice: me3/me4/me5
    Illustration Rare cards showed real TCG API data available but stayed
    N/A in the CSV because they hit this exact gap.

    This reuses the SAME prices_by_number data already fetched this run
    (no extra TCG API calls) to patch those preserved rows in-place before
    they're written to the new CSV, so a pokemontcg.io hiccup no longer
    permanently blocks Mega Evolution pricing.

    Mutates existing_rows in place. Returns the count of rows patched.
    """
    if not fetched_prices_by_set:
        return 0

    patched = 0
    for card_id in missing_ids:
        # pokemontcg.io card IDs are "{set_id}-{number}", e.g. "me3-93".
        set_id, _, raw_number = card_id.rpartition("-")
        if set_id not in fetched_prices_by_set:
            continue

        row = existing_rows[card_id]
        # Only patch if this row doesn't already have a real price — don't
        # clobber a previously-successful pokemontcg.io price with something
        # else, and don't bother re-writing a price that's already current.
        if row.get("Price", "N/A") not in ("N/A", "", None):
            continue

        number = raw_number.strip().lstrip("0") or "0"
        price_info = fetched_prices_by_set[set_id].get(number)
        if not price_info:
            continue

        row["Price"] = f"${price_info['market']:.2f}"
        # This card now has a real price as of today — reflect that in Last
        # Priced, same as a normal fresh-fetch price would (see main()'s
        # last_priced logic). Last Checked deliberately NOT touched: the
        # pokemontcg.io card-data fetch itself still failed today, so it
        # would be misleading to claim the API was successfully queried.
        row["Last Priced"] = today
        patched += 1

    if patched:
        print(f"  Backfilled {patched} preserved (fallback) card(s) with "
              f"TCG API pricing that would otherwise have stayed N/A.")

    return patched


def patch_vintage_ecard_prices(compiled_cards):
    """Backfill prices for Aquapolis/Skyridge "H1-H9" secret rares via TCG API.

    BUG FOUND (2026-07-27): within the Aquapolis and Skyridge Crystal/Holo
    secret-rare "H" subsets (H1-H32 in each set), pokemontcg.io/TCGplayer has
    price data for H10-H32 but NOT H1-H9 — a TCGplayer market-data gap for
    those 9 specific numbers in each set (card records themselves fetch fine,
    e.g. "ecard2-H1" resolves, just with no price). See VINTAGE_ECARD_SET_IDS
    comment for full details and confirmation via TCG API.

    Unlike patch_mega_evolution_prices() (where pokemontcg.io has ZERO prices
    for the whole series), most cards in these two sets already have a real
    pokemontcg.io price — only H1-H9 are missing. So this only patches cards
    that don't already have a usable price, to avoid clobbering a perfectly
    good existing pokemontcg.io/TCGplayer price with a TCG API one.

    Returns {pokemontcg_set_id: prices_by_number, ...} for every set actually
    queried this run, so main() can reuse the same fetched prices to also
    patch fallback rows — same reasoning as patch_mega_evolution_fallback_rows().
    """
    # Group affected cards by their pokemontcg.io set.id — only cards that
    # don't already have a usable price need patching.
    cards_by_set = {}
    for card in compiled_cards:
        set_id = card.get("set", {}).get("id", "")
        if set_id not in VINTAGE_ECARD_SET_IDS:
            continue
        price_num, _ = parse_card_price(card)
        if price_num is not None:
            continue  # already priced fine by pokemontcg.io — leave it alone
        cards_by_set.setdefault(set_id, []).append(card)

    if not cards_by_set:
        return {}

    print(f"\nPatching prices via TCG API for vintage e-Card secret rares "
          f"({sum(len(v) for v in cards_by_set.values())} cards, "
          f"{len(cards_by_set)} set(s))...")

    global TCG_API_QUOTA_EXHAUSTED
    sets_skipped = []
    fetched_prices_by_set = {}

    for set_id, cards in cards_by_set.items():
        if TCG_API_QUOTA_EXHAUSTED:
            sets_skipped.append(set_id)
            continue

        tcg_api_set_id = VINTAGE_ECARD_SET_IDS[set_id]
        print(f"  {set_id} -> TCG API set_id {tcg_api_set_id} ({len(cards)} cards)")
        prices_by_number = fetch_tcg_api_prices_for_set(tcg_api_set_id)
        fetched_prices_by_set[set_id] = prices_by_number

        patched = 0
        for card in cards:
            raw_number = card.get("number") or ""
            number = normalize_tcg_api_number(raw_number)
            price_info = prices_by_number.get(number)
            if price_info:
                printing_key = "holofoil" if "foil" in price_info["printing"].lower() else "normal"
                card["tcgplayer"] = card.get("tcgplayer", {})
                card["tcgplayer"]["prices"] = {
                    printing_key: {"market": price_info["market"]}
                }
                patched += 1

        print(f"    -> {patched}/{len(cards)} cards priced from TCG API")

    if sets_skipped:
        skipped_card_count = sum(len(cards_by_set[s]) for s in sets_skipped)
        print(f"  Skipped {len(sets_skipped)} set(s) ({', '.join(sets_skipped)}, "
              f"{skipped_card_count} cards) — TCG API daily quota exhausted. "
              f"These cards keep their existing price (blank or preserved "
              f"from yesterday's CSV) until the quota resets and a future "
              f"run can retry them.")

    return fetched_prices_by_set


def patch_vintage_ecard_fallback_rows(missing_ids, existing_rows, fetched_prices_by_set, today):
    """Apply TCG API prices to vintage e-Card cards preserved via fallback.

    BUG FIX (2026-07-27): the original version of this function ONLY reused
    prices already fetched during patch_vintage_ecard_prices()'s pass over
    compiled_cards this run — but that pass only queries TCG API for a set
    if at least one card from that set appears in compiled_cards (i.e.
    pokemontcg.io's OWN query succeeded for it today). The Aquapolis/Skyridge
    "H" cards come from a SEPARATE pokemontcg.io query (subtypes:"Crystal")
    from the one that fetches other cards in those same sets (e.g. rarity:
    "Rare Secret" set.series:"EX") — so when that Crystal-subtype query fails
    outright (confirmed happened in practice: all 64 H1-H32 cards across both
    sets fell to fallback, Last Checked stayed on yesterday's date, while a
    handful of Rare Secret cards in the same two sets fetched fine), NONE of
    those H-cards were ever in compiled_cards, fetched_prices_by_set never
    got an entry for "ecard2"/"ecard3", and this function had nothing to
    patch from — despite TCG API having real prices the whole time.
    Confirmed via manual PowerShell check against TCG API directly.

    Fix: independently fetch TCG API prices for any vintage e-Card set that
    has unpriced fallback rows this run, instead of only reusing whatever
    happened to get fetched during the main compiled_cards pass. Falls back
    to fetched_prices_by_set first to avoid a redundant TCG API call if the
    main pass already covered that set.

    Mutates existing_rows in place. Returns count patched.
    """
    # Group missing (fallback) card IDs by set, but only ones that need a
    # price (row currently N/A/blank) and only for vintage e-Card sets.
    needed_by_set = {}
    for card_id in missing_ids:
        set_id, _, raw_number = card_id.rpartition("-")
        if set_id not in VINTAGE_ECARD_SET_IDS:
            continue
        row = existing_rows.get(card_id)
        if not row or row.get("Price", "N/A") not in ("N/A", "", None):
            continue
        needed_by_set.setdefault(set_id, []).append((card_id, raw_number))

    if not needed_by_set:
        return 0

    global TCG_API_QUOTA_EXHAUSTED
    patched = 0

    for set_id, id_number_pairs in needed_by_set.items():
        prices_by_number = fetched_prices_by_set.get(set_id) if fetched_prices_by_set else None
        if prices_by_number is None:
            if TCG_API_QUOTA_EXHAUSTED:
                continue
            tcg_api_set_id = VINTAGE_ECARD_SET_IDS[set_id]
            print(f"  Fetching TCG API prices for fallback rows in {set_id} "
                  f"(set_id {tcg_api_set_id}) — not covered by this run's "
                  f"main pokemontcg.io fetch...")
            prices_by_number = fetch_tcg_api_prices_for_set(tcg_api_set_id)

        for card_id, raw_number in id_number_pairs:
            row = existing_rows[card_id]
            number = normalize_tcg_api_number(raw_number)
            price_info = prices_by_number.get(number)
            if not price_info:
                continue

            row["Price"] = f"${price_info['market']:.2f}"
            row["Last Priced"] = today
            patched += 1

    if patched:
        print(f"  Backfilled {patched} preserved (fallback) vintage e-Card "
              f"card(s) with TCG API pricing that would otherwise have "
              f"stayed N/A.")

    return patched


def patch_pinned_price_overrides(compiled_cards, existing_rows, today):
    """Apply PINNED_PRICE_OVERRIDES to matching cards, wherever they are.

    See PINNED_PRICE_OVERRIDES comment for why these specific cards (Wizards
    Black Star Promos Pikachu #1 / Smeargle #32) need a manual override
    instead of the normal TCG-API-fallback mechanism. Handles both cases: the
    card is in compiled_cards (pokemontcg.io fetched it fine today, just with
    no price), or it's a fallback row in existing_rows (pokemontcg.io's fetch
    failed today, preserved from yesterday's CSV). Only overrides a price
    that's currently missing/N/A — never clobbers a real pokemontcg.io price
    should one ever appear for these cards.

    Returns the count of cards patched.
    """
    if not PINNED_PRICE_OVERRIDES:
        return 0

    patched = 0

    for card in compiled_cards:
        card_id = card.get("id", "")
        if card_id not in PINNED_PRICE_OVERRIDES:
            continue
        price_num, _ = parse_card_price(card)
        if price_num is not None:
            continue  # already has a real pokemontcg.io price — leave it alone
        market = PINNED_PRICE_OVERRIDES[card_id]
        card["tcgplayer"] = card.get("tcgplayer", {})
        card["tcgplayer"]["prices"] = {"normal": {"market": market}}
        patched += 1

    for card_id, market in PINNED_PRICE_OVERRIDES.items():
        row = existing_rows.get(card_id)
        if not row or row.get("Price", "N/A") not in ("N/A", "", None):
            continue
        row["Price"] = f"${market:.2f}"
        row["Last Priced"] = today
        patched += 1

    if patched:
        print(f"  Applied {patched} manually-pinned price override(s) "
              f"(see PINNED_PRICE_OVERRIDES).")

    return patched


def load_previous_prices():
    """Read existing CSV to get previous prices keyed by Card ID."""
    prev = {}
    if not os.path.exists(OUTPUT_FILE):
        return prev
    try:
        with open(OUTPUT_FILE, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                card_id = row.get("Card ID", "").strip()
                price = row.get("Price", "N/A").strip()
                if card_id:
                    prev[card_id] = price
    except Exception as e:
        print(f"  Warning: could not read previous prices: {e}")
    return prev


def load_last_priced_dates():
    """Read existing CSV to get 'Last Priced' dates keyed by Card ID.
    This is the most recent date each card had a real (non-N/A) price,
    used to track how stale a card's pricing is."""
    last_priced = {}
    if not os.path.exists(OUTPUT_FILE):
        return last_priced
    try:
        with open(OUTPUT_FILE, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                card_id = row.get("Card ID", "").strip()
                lp = row.get("Last Priced", "").strip()
                if card_id and lp:
                    last_priced[card_id] = lp
    except Exception as e:
        print(f"  Warning: could not read last priced dates: {e}")
    return last_priced


def load_existing_csv_rows():
    """Read existing CSV into a dict keyed by Card ID for fallback merging."""
    rows = {}
    if not os.path.exists(OUTPUT_FILE):
        return rows
    try:
        with open(OUTPUT_FILE, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                card_id = row.get("Card ID", "").strip()
                if card_id:
                    rows[card_id] = row
    except Exception as e:
        print(f"  Warning: could not read existing CSV for fallback: {e}")
    return rows


def load_price_history():
    """Load existing price history JSON (card_id -> [{d: date, p: price}, ...])."""
    if not os.path.exists(HISTORY_FILE):
        return {}
    try:
        with open(HISTORY_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"  Warning: could not load price history: {e}")
        return {}


def save_price_history(history):
    """Write updated price history JSON."""
    with open(HISTORY_FILE, "w", encoding="utf-8") as f:
        json.dump(history, f, separators=(",", ":"))


def main():
    run_start_time = time.time()
    today = date.today().isoformat()
    compiled_cards = []
    seen_ids = set()

    for query in QUERIES:
        results = fetch_cards_by_query(query, API_KEY)
        new_count = 0
        for card in results:
            card_id = card.get("id")
            if card_id not in seen_ids:
                seen_ids.add(card_id)
                compiled_cards.append(card)
                new_count += 1
        print(f"  -> {new_count} new unique cards added (running total: {len(compiled_cards)})")

    print(f"\nTotal unique chase cards found: {len(compiled_cards)}")

    # Backfill pricing for Mega Evolution series cards via TCG API — see
    # patch_mega_evolution_prices() docstring for why pokemontcg.io is skipped
    # for this series entirely. Keep the returned prices so they can also
    # patch fallback (preserved-from-yesterday) rows further down — see
    # patch_mega_evolution_fallback_rows() for why that's needed too.
    mega_evolution_prices_by_set = patch_mega_evolution_prices(compiled_cards)

    # Backfill pricing for Aquapolis/Skyridge "H1-H9" secret rares via TCG
    # API — see patch_vintage_ecard_prices() docstring. Unlike Mega
    # Evolution, most cards in these sets already have a real pokemontcg.io
    # price, so this only touches the specific cards missing one.
    vintage_ecard_prices_by_set = patch_vintage_ecard_prices(compiled_cards)

    # Filter out non-chase rarities that slipped through (e.g., WotC Promo commons)
    ALLOWED_RARITIES = {
        # ── Scarlet & Violet ──────────────────────────────────────────────────
        "Mega Hyper Rare",           # ~1:1260 — apex SV pull
        "MEGA_ATTACK_RARE",          # secret-numbered SV chase tier (Ascended Heroes onward)
        "Special Illustration Rare", # SIR/SAR — painterly full-bleed apex
        "Illustration Rare",         # IR — borderless full-art
        "ACE SPEC Rare",             # 1-per-deck SV mechanic; Master Ball, Prime Catcher tier
        # "Double Rare" intentionally excluded — fetched by specific card ID only (see QUERIES above)
        # ── Paldean Fates (SV shiny set) ──────────────────────────────────────
        # "Shiny Rare" excluded — non-ex Paldean Fates shinies are bulk (Rowlet, Wooper etc.)
        "Shiny Ultra Rare",          # Paldean Fates shiny ex tier (chase)
        # ── Sword & Shield ────────────────────────────────────────────────────
        "Hyper Rare",                # Rainbow Rare — rarest SWSH single-card pull
        "Trainer Gallery Rare Holo", # TG subset — Brilliant Stars through Crown Zenith
        "Rare Holo VSTAR",           # Crown Zenith Galarian Gallery GG35–GG66 VSTAR tier
        "Amazing Rare",              # Lightning/rainbow art — Vivid Voltage+
        "Rare Shiny GX",             # Shiny Vault GX (Hidden Fates / Shining Fates)
        # "Rare Shiny" excluded — non-GX shinies are bulk (shiny Caterpie etc.), not chase.
        # Exception: Shiny Eevee (sma-SV41) pinned individually below — genuine outlier price.
        "Radiant Rare",              # 1-per-deck SWSH mechanic
        # ── Sun & Moon ────────────────────────────────────────────────────────
        "Rare Rainbow",              # SM Rainbow Rare (distinct from SWSH Hyper Rare)
        "Rare Ultra",                # Full Art GX / Tag Team GX / Full Art Supporters
        # ── BW / XY / DP / HGSS (Secret Rares) ──────────────────────────────
        "Rare Secret",               # Gold-border Secret Rares across all middle eras
        # ── DP / HGSS ─────────────────────────────────────────────────────────
        "Rare Holo LV.X",            # DP/Platinum LV.X mechanic — rarity string used by API
        "Rare Prime",                # HGSS silver-border chase rares
        "Rare Holo Star",            # DP-era shiny star + Call of Legends SL cards
        # ── Neo era ───────────────────────────────────────────────────────────
        "Rare Shining",              # Shining Charizard / Mewtwo / Tyranitar
        # ── Vintage ───────────────────────────────────────────────────────────
        "Rare Holo",                 # THE vintage chase card (scoped by series in queries)
        # WotC Promos and Celebrations pass via WOTC_PROMO_SET_NAMES whitelist below,
        # NOT via rarity string — avoids "Rare" catching bulk like Flareon from 151
    }
    # BUG FIX (2026-07-24): "LV.X" corrected to "Level-Up" — that's the actual API
    # subtype value for LV.X cards ("LV.X" only appears in the card name field).
    ALLOWED_SUBTYPES = {"Gold Star", "LEGEND", "Level-Up", "Crystal"}

    # WotC Black Star Promos: the set query may return commons/uncommons (Pikachu promos).
    # We keep ALL results from that set — they are individually significant as promos.
    WOTC_PROMO_SET_NAMES = {
        "Wizards Black Star Promos",
        "Crown Zenith Galarian Gallery",       # all 70 cards are gallery chase pulls
        # Hidden Fates / Shining Fates Shiny Vaults: NOT whitelisted — rarity filter handles it.
        # "Rare Shiny GX" is in ALLOWED_RARITIES (chase tier: shiny Charizard-GX etc.)
        # "Rare Shiny" is NOT in ALLOWED_RARITIES (bulk tier: shiny Rowlet, Caterpie, Wooper etc.)
        "Brilliant Stars Trainer Gallery",     # all 30 cards
        "Astral Radiance Trainer Gallery",     # all 30 cards
        "Lost Origin Trainer Gallery",         # all 30 cards
        "Silver Tempest Trainer Gallery",      # all 30 cards
    }

    # Sets explicitly excluded regardless of rarity — novelty/specialty sets with no chase value
    EXCLUDED_SET_NAMES = {
        "Detective Pikachu",
        "Base Set 2",
        "Legendary Collection",        # all reprints, no chase value
        "ME: Mega Evolution Promo",    # modern Black Star Promo set — excluded per criteria
        "Celebrations",                # 25th anniversary reprints — mass printed, low value
        "Celebrations: Classic Collection",  # golden-border reprints, not true chase
    }

    # ── Manually-synthesized cards (not in pokemontcg.io at all) ──────────────
    # FEATURE (2026-07-30): Ancient Mew is one of the most iconic and
    # consistently valuable Pokémon promos ever released (1999 "Mewtwo
    # Strikes Back" / Movie 2000 theatrical promo) but pokemontcg.io's
    # database simply does not have it — confirmed via direct API query
    # (q=name:"Ancient Mew" returns zero results), so there's no real card
    # object to fetch or pin by ID like the other PINNED_CARD_IDS entries
    # below. Instead we hand-build a card dict shaped exactly like a real
    # pokemontcg.io API response and inject it into compiled_cards before
    # filtering, so it flows through the normal pipeline (price history,
    # dedup, sort, CSV write) unmodified. Price is a manual estimate —
    # ungraded/raw market price researched July 2026 (~$70-75 range across
    # PriceCharting/BankTCG); update MANUAL_CARD_PRICES below if you want to
    # refresh it during a future session rather than editing this dict.
    MANUAL_CARD_PRICES = {
        "manual-ancient-mew": 71.51,
    }
    MANUAL_SYNTHETIC_CARDS = [
        {
            "id": "manual-ancient-mew",
            "name": "Ancient Mew",
            "number": "—",
            "rarity": "Promo",
            "supertype": "Pokémon",
            "subtypes": ["Basic"],
            "images": {
                "large": "https://images.pokemontcg.io/basep/misc/ancient-mew.png"
            },
            "set": {
                "id": "manual-promos",
                "name": "Movie Promos",
                "series": "Wizards of the Coast",
                # Theatrical release date for the 2000 US "Mewtwo Strikes
                # Back" bundled promo — used for sort order / era grouping.
                "releaseDate": "2000/07/18",
                "printedTotal": None,
                "total": None,
                "ptcgoCode": "PROMO",
                "images": {"logo": "N/A", "symbol": "N/A"},
            },
            "tcgplayer": {
                "prices": {"normal": {"market": MANUAL_CARD_PRICES["manual-ancient-mew"]}}
            },
        },
    ]
    compiled_cards.extend(MANUAL_SYNTHETIC_CARDS)
    print(f"  Injected {len(MANUAL_SYNTHETIC_CARDS)} manually-synthesized card(s) "
          f"not available via pokemontcg.io (see MANUAL_SYNTHETIC_CARDS).")

    # Pinned card IDs — fetched by specific ID and bypass the rarity filter entirely.
    # Used for cards whose API rarity string wouldn't pass ALLOWED_RARITIES but are
    # genuine chase cards (specific Double Rares, promos, etc.).
    PINNED_CARD_IDS = {
        "manual-ancient-mew",  # Ancient Mew — see MANUAL_SYNTHETIC_CARDS above.
        "sv3-125",        # Charizard ex (Obsidian Flames) — Tera Dark Double Rare; ~$5-6 market
        "swshp-SWSH230",  # Radiant Eevee — SWSH Black Star Promo; Pokémon GO Premium Collection box
        "sma-SV41",       # Shiny Eevee (Hidden Fates Shiny Vault) — non-GX "Rare Shiny" tier is
                          # bulk overall (shiny Rowlet/Caterpie/Wooper etc. sit $1-5), but this
                          # specific card is a genuine outlier: ~$54 TCGplayer market (July 2026).
                          # Verified via API — plain (non-GX) rarity "Rare Shiny", confirmed real price.
        "sma-SV6",        # Shiny Charmander (Hidden Fates Shiny Vault) — non-GX "Rare Shiny" tier,
                          # ~$33.60 TCGplayer market (July 2026) — clear standout vs. $1-5 bulk peers.
        "sma-SV9",        # Shiny Wooper (Hidden Fates Shiny Vault) — non-GX "Rare Shiny" tier,
                          # ~$27.74 TCGplayer market (July 2026) — clear standout vs. $1-5 bulk peers.
    }

    def is_chase(card):
        rarity = card.get("rarity", "")
        subtypes = card.get("subtypes", [])
        set_name = card.get("set", {}).get("name", "")
        card_id = card.get("id", "")
        if set_name in EXCLUDED_SET_NAMES:
            return False
        if card_id in PINNED_CARD_IDS:
            return True
        if set_name in WOTC_PROMO_SET_NAMES:
            return True
        if rarity in ALLOWED_RARITIES:
            return True
        if any(s in ALLOWED_SUBTYPES for s in subtypes):
            return True
        return False

    before = len(compiled_cards)
    compiled_cards = [c for c in compiled_cards if is_chase(c)]
    print(f"  Filtered out {before - len(compiled_cards)} non-chase cards")

    compiled_cards.sort(key=lambda c: (
        c.get("set", {}).get("releaseDate", ""),
        c.get("set", {}).get("name", ""),
        c.get("number", "")
    ))

    # ── Load existing CSV rows for fallback merge ─────────────────────────────
    # If the API fails a query today, we preserve yesterday's rows for those
    # cards so they don't vanish from the app. Keyed by card_id.
    print(f"\nLoading existing CSV for fallback merge...")
    existing_rows = load_existing_csv_rows()
    print(f"  Found {len(existing_rows)} existing cards in CSV.")

    # Find card IDs successfully fetched this run
    fetched_ids = {c.get("id", "") for c in compiled_cards}

    # Cards in the old CSV but not fetched today — API likely failed their query
    missing_ids = set(existing_rows.keys()) - fetched_ids
    if missing_ids:
        print(f"  {len(missing_ids)} cards not fetched today — preserving from yesterday's CSV.")
    else:
        print(f"  All existing cards re-fetched successfully.")

    # BUG FIX (2026-07-24): preserved/fallback rows above never pass through
    # patch_mega_evolution_prices() (that only touches compiled_cards, i.e.
    # cards pokemontcg.io successfully fetched THIS run). Since pokemontcg.io
    # has never had real prices for the Mega Evolution series, any ME card
    # whose fetch failed today would stay stuck at N/A forever otherwise.
    # Patch those preserved rows in-place using the prices already fetched
    # above — no extra TCG API calls needed.
    if missing_ids:
        patch_mega_evolution_fallback_rows(missing_ids, existing_rows, mega_evolution_prices_by_set, today)
        patch_vintage_ecard_fallback_rows(missing_ids, existing_rows, vintage_ecard_prices_by_set, today)

    # Apply manually-pinned price overrides (see PINNED_PRICE_OVERRIDES) —
    # runs unconditionally (not gated on missing_ids) since the pinned card
    # may be in compiled_cards (fresh-fetched fine, just no price) rather
    # than a fallback row.
    patch_pinned_price_overrides(compiled_cards, existing_rows, today)

    # ── Load previous prices + history before overwriting ─────────────────────
    print(f"\nLoading previous prices from existing CSV...")
    previous_prices = load_previous_prices()
    print(f"  Found {len(previous_prices)} previous price entries.")

    print(f"Loading last-priced dates from existing CSV...")
    last_priced_dates = load_last_priced_dates()
    print(f"  Found {len(last_priced_dates)} last-priced entries.")

    print(f"Loading price history from {HISTORY_FILE}...")
    price_history = load_price_history()
    print(f"  History contains {len(price_history)} cards.")

    # Check if file is locked
    if os.path.exists(OUTPUT_FILE):
        try:
            with open(OUTPUT_FILE, "a"):
                pass
        except PermissionError:
            print("\nERROR: The CSV file is open in another program (Excel?).")
            print("Please close it and press Enter to retry...")
            input()

    # Write to temp files first — live files are only replaced after a fully
    # successful write, so a mid-run crash never corrupts the existing data.
    TEMP_CSV     = OUTPUT_FILE  + ".tmp"
    TEMP_HISTORY = HISTORY_FILE + ".tmp"

    print(f"Writing to temp file {TEMP_CSV}...")
    fallback_count = 0

    with open(TEMP_CSV, mode="w", newline="", encoding="utf-8") as file:
        writer = csv.writer(file)
        writer.writerow([
            "Release Date", "Series", "Set Name", "Set Code", "Card Name",
            "Card Number", "Set Total", "Rarity", "Price", "Previous Price", "Card ID", "Picture URL", "Set Logo", "Set Symbol",
            "Last Checked", "Last Priced", "Supertype", "Subtypes"
        ])

        for card in compiled_cards:
            set_info = card.get("set", {})
            release_date = set_info.get("releaseDate", "N/A")
            series = set_info.get("series", "N/A")
            set_name = set_info.get("name", "N/A")
            card_name = card.get("name", "N/A")
            card_number = card.get("number", "N/A")
            # printedTotal is the number on the card back (e.g. 102 in "25/102")
            # Fall back to total (which may include secret rares) if printedTotal missing
            set_total = set_info.get("printedTotal") or set_info.get("total") or ""
            rarity = card.get("rarity", "N/A")
            card_id = card.get("id", "")
            price_num, price_str = parse_card_price(card)
            picture_url = card.get("images", {}).get("large", "N/A")
            set_logo = set_info.get("images", {}).get("logo", "N/A")
            set_symbol = set_info.get("images", {}).get("symbol", "N/A")
            set_code = set_info.get("ptcgoCode", set_info.get("id", "N/A")).upper()
            supertype = card.get("supertype", "N/A")
            # subtypes is a list, e.g. ["Basic","EX"] or ["Basic","TAG TEAM","GX"] —
            # join with "|" so it stays a single CSV field; used to reliably tell
            # apart Full Art EX / GX / plain / Trainer cards instead of guessing
            # from the card name (which doesn't always contain "EX" or "GX").
            subtypes = "|".join(card.get("subtypes", []) or [])

            # Previous price: use the most recent history entry before today.
            # This is more reliable than reading the old CSV column, because the
            # history is updated daily and reflects real prior-day prices.
            prev_price = "N/A"
            hist_entries = price_history.get(card_id, [])
            # Filter out any entry already written for today (idempotent guard)
            prior_entries = [e for e in hist_entries if e["d"] != today]
            if prior_entries:
                last_p = prior_entries[-1]["p"]
                prev_price = f"${last_p:.2f}"
            elif previous_prices.get(card_id):
                prev_price = previous_prices.get(card_id, "N/A")

            # Last Checked: every card fetched this run was checked today, regardless
            # of whether a price came back — this tells us the API was queried for it.
            last_checked = today

            # Last Priced: the most recent date this card actually resolved to a real
            # price. If we got a price today, that's today. Otherwise carry forward
            # whatever the last known-good date was (so staleness is visible over time).
            if price_num is not None:
                last_priced = today
            else:
                last_priced = last_priced_dates.get(card_id, "")

            writer.writerow([
                release_date, series, set_name, set_code, card_name,
                card_number, set_total, rarity, price_str, prev_price, card_id, picture_url, set_logo, set_symbol,
                last_checked, last_priced, supertype, subtypes
            ])

            # Update price history
            if card_id and price_num is not None:
                if card_id not in price_history:
                    price_history[card_id] = []
                # Only add entry if date is new (daily runs are idempotent)
                existing_dates = {entry["d"] for entry in price_history[card_id]}
                if today not in existing_dates:
                    price_history[card_id].append({"d": today, "p": price_num})
                    # Keep last 365 data points
                    if len(price_history[card_id]) > 365:
                        price_history[card_id] = price_history[card_id][-365:]

        # Write fallback rows for cards not fetched today (API failures)
        # Last Checked is NOT updated for these — the API wasn't successfully
        # queried for this card today, so its prior Last Checked date is preserved.
        # This is what lets a stale fallback card be spotted over time.
        for card_id in missing_ids:
            row = existing_rows[card_id]
            writer.writerow([
                row.get("Release Date", "N/A"),
                row.get("Series", "N/A"),
                row.get("Set Name", "N/A"),
                row.get("Set Code", "N/A"),
                row.get("Card Name", "N/A"),
                row.get("Card Number", "N/A"),
                row.get("Set Total", ""),
                row.get("Rarity", "N/A"),
                row.get("Price", "N/A"),
                row.get("Previous Price", "N/A"),
                card_id,
                row.get("Picture URL", "N/A"),
                row.get("Set Logo", "N/A"),
                row.get("Set Symbol", "N/A"),
                row.get("Last Checked", ""),
                row.get("Last Priced", ""),
                row.get("Supertype", "N/A"),
                row.get("Subtypes", ""),
            ])
            fallback_count += 1

            # Record price history for fallback rows too — otherwise a card
            # patched via patch_mega_evolution_fallback_rows() (or any future
            # fallback price source) would show a real Price in the CSV but
            # never appear in the price-history trend data.
            fallback_price_str = row.get("Price", "N/A")
            if card_id and fallback_price_str not in ("N/A", "", None):
                try:
                    fallback_price_num = float(fallback_price_str.lstrip("$"))
                except (ValueError, AttributeError):
                    fallback_price_num = None
                if fallback_price_num is not None:
                    if card_id not in price_history:
                        price_history[card_id] = []
                    existing_dates = {entry["d"] for entry in price_history[card_id]}
                    if today not in existing_dates:
                        price_history[card_id].append({"d": today, "p": fallback_price_num})
                        if len(price_history[card_id]) > 365:
                            price_history[card_id] = price_history[card_id][-365:]

        if fallback_count:
            print(f"  Preserved {fallback_count} cards from yesterday's CSV (API fetch failed).")

    # Save updated price history to temp
    print(f"Saving price history to temp file {TEMP_HISTORY}...")
    with open(TEMP_HISTORY, "w", encoding="utf-8") as f:
        json.dump(price_history, f, separators=(",", ":"))

    # Both writes succeeded — atomically replace the live files
    os.replace(TEMP_CSV, OUTPUT_FILE)
    os.replace(TEMP_HISTORY, HISTORY_FILE)
    print("Live files updated.")

    total_written = len(compiled_cards) + fallback_count
    expected_total = len(existing_rows) if existing_rows else total_written

    elapsed_seconds = time.time() - run_start_time
    minutes, seconds = divmod(int(elapsed_seconds), 60)
    elapsed_str = f"{minutes}m {seconds}s" if minutes else f"{seconds}s"

    print(f"\n{'='*50}")
    print(f"  CARDS LIVE IN APP:     {total_written}")
    print(f"  FRESHLY FETCHED:       {len(compiled_cards)}")
    print(f"  PRESERVED (FALLBACK):  {fallback_count}")
    print(f"  EXPECTED (YESTERDAY):  {expected_total}")
    print(f"  PRICE HISTORY:         {len(price_history)} cards tracked")
    print(f"  TOTAL RUN TIME:        {elapsed_str}")
    print(f"{'='*50}")


if __name__ == "__main__":
    main()
