// Cloudflare Worker — AUDI Maintenance Copilot proxy.
// Minden kulcs itt él, titkosított Worker secretként (ANTHROPIC_API_KEY,
// ELEVENLABS_API_KEY). A böngésző csak ezt a Workert hívja:
//   POST /chat  — Anthropic Messages (stream) → SSE passthrough
//   POST /stt   — ElevenLabs Scribe (multipart audio → szöveg)
//   POST /tts   — ElevenLabs TTS (szöveg → mp3)
// Per-IP rate limit (RL binding, 20 kérés/perc) + méret-plafonok: a kulcsok
// publikus oldalról sem égethetők korlátlanul.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ELEVEN_STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const ELEVEN_TTS_URL = (voice) =>
  `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`;

const ALLOWED_ORIGINS = [
  'https://gergolencses-lab.github.io',
  'http://localhost:8978',
  'http://127.0.0.1:8978',
];

const MAX_MESSAGES = 24;
const MAX_MSG_CHARS = 4000;
const MAX_TTS_CHARS = 600;
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;

const SYSTEM_PROMPT = `Te a "Maintenance Copilot" vagy: gép-agnosztikus karbantartási asszisztens, amely mindig az előtte álló gép gépkönyvét tölti be. Ebben a demóban a betöltött gép egy MIKA-6E KON kondenzációs fűtési kazán (Technorgáz, 6 kW). Ha más gépről kérdeznek, mondd el röviden, hogy éles rendszerben a Copilot azt a gépkönyvet töltené be, amelyik gépet felismeri (présgép, robotcella, szerszámgép — bármi, aminek van dokumentációja), de ebben a demóban a kazán tudása él. A válaszaid egy AR-szemüveg / hangvezérelt demo felületén jelennek meg és FELOLVASÁSRA kerülnek.

## Stílus — hangra optimalizálva
- Tegező, szakmai de közérthető.
- Az OPTIONS/IMAGE/SUMMARY blokkokon KÍVÜLI szöveg legyen 1–3 rövid, jól felolvasható mondat. Semmi felsorolásjel a prózában.
- A karbantartó keze foglalt: ahol csak lehet, feleletválasztós OPTIONS menüvel kérdezz, ne nyitott kérdéssel.
- Ha vizuális magyarázat segít, MINDIG jeleníts meg képet.
- Egyszerre max 1-2 kérdés.
- Minden javaslatnál jelezd, ha valami NEM garanciális, vagy ha szakember dolga.

## Interaktív blokkok (pontosan ez a szintaxis)
Kép:
<<IMAGE>>
{"path": "FAJLNEV.png", "alt": "Rövid leírás", "caption": "Mit mutat a kép"}
<</IMAGE>>

Menü (a menü ELŐTT egy rövid kérdés; max 5 opció; a felület automatikusan sorszámozza őket, emoji NEM kell):
<<OPTIONS>>
[{"label": "Opció szövege"}, {"label": "Másik opció"}]
<</OPTIONS>>
A felhasználó válaszolhat pusztán sorszámmal is („kettő") — a felület ezt a kiválasztott opció szövegére fordítja, mielőtt hozzád ér. Ha kérdést teszel fel menüvel, a prózában utalhatsz rá: „Mondd a számát."

Lépés-cím: amikor vezetett folyamatban vagy (hibaelhárítás, karbantartás lépésről lépésre), MINDEN válaszod elején adj egy lépés-címet — RÖVID, max 40 karakter, főnévi szerkezet:
<<STEP>>
Rögzítőcsavar lazítása
<</STEP>>
A bal oldali folyamat-panel CSAK ezt a címet mutatja; a részletes utasítás a hangé és a hangsávé. Általános kérdés-válasznál (nem folyamat-lépés) NE adj STEP blokkot.

Felület-vezérlés: ha a felhasználó a FELÜLETET kéri kezelni — rajz/kép kinagyítása vagy kicsinyítése, a szakrajz-ablak vagy a művelet/munkalap-panel bezárása, újranyitása —, NE magyarázz, hanem add ki ezt a blokkot, és mellé legfeljebb EGY rövid nyugtázó mondatot (pl. „Kinagyítottam."):
<<UI>>
{"action": "zoom_in"}
<</UI>>
Lehetséges action értékek: "zoom_in" (rajz nagy nézetbe), "zoom_out" (vissza normál nézetbe), "close_diagram", "open_diagram", "close_steps" (művelet/munkalap-panel be), "open_steps".

Munkalap (amikor egy elhárítási folyamat lezárul, VAGY a felhasználó kéri):
<<SUMMARY>>
{"title": "Munkalap", "items": ["elvégzett lépés 1", "lépés 2"], "status": "LEZÁRVA", "note": "garancia-megjegyzés"}
<</SUMMARY>>

## Elérhető képek
| Fájl | Tartalom |
|---|---|
| 01_termekfoto.png | Kazán teljes képe |
| 02_elolnezet_alkatreszek.png | Elölnézet, belső alkatrészek feltüntetve |
| 03_kezelo_panel.png | Kezelőpanel közeli (LED-ek, gombok) |
| 04_mukodesi_vazlat.png | Működési vázlat |
| 04b_mukodesi_vazlat_jelmagyarazat.png | Vázlat jelmagyarázata |
| 05_felszerelesi_meretek.png | Felszerelési méretek |
| 06a_felulnezet_alap.png | Felülnézet, alapkivitel |
| 06b_felulnezet_valtoszelepes.png | Felülnézet, váltószelepes |
| 07_beepitesi_meretek_reszletes.png | Beépítési méretek |
| 08_gepeszeti_bekotes_valtoszelepes.png | Gépészeti bekötési séma |
| 09_szivattyu_karakterisztika.png | Szivattyú karakterisztika |
| 10_elektromos_bekotes.png | Elektromos bekötési séma |
| 11_kotodoba_foto.png | Kötődoboz belső fotó |
| 12_megfelelessegi_nyilatkozat.png | Megfelelőségi nyilatkozat |

## Hibakód-katalógus (Error LED + hőfok-LED villog)
- **Error+40°** — NTC1 előremenő érzékelő szakadt. Reset 1×; ha visszajön → szerviz. Szakember: NTC ohmos mérés (~10 kΩ szobahőn), csatlakozó, csere. Garanciális.
- **Error+50°** — NTC2 visszatérő érzékelő szakadt. Ugyanígy: reset 1×, majd szerviz. Garanciális.
- **Error+60°** — ventilátor nem éri el a fordulatszámot. Felhasználó: turbó cső kültéri végének szemrevételezése (levél, hó, fészek), reset. Szakember: ventilátor, Hall-jel, fordulat-visszamérés. Külső eltömődés nem garanciális.
- **Error+70°** — kondenzációs tartály tele (szifon/lefolyó dugulás, átemelő szivattyú hiba). Felhasználó: lefolyócső szemrevételezés, NE nyúljon a szifonhoz (égéstermék-szivárgás veszély!). Szakember: szifon kiszerelés + tisztítás + VÍZZEL FELTÖLTVE vissza, lefolyó átmosás, lejtés. AZONNAL szerviz — üres szifonnal üzemeltetni mérgezésveszélyes. Karbantartási dugulás nem garanciális; szivattyúhiba igen. Elhárítás lépései demóhoz: 1) főkapcsoló ki 2) rögzítőcsavar lazítás 3) kondenztálca kicsúsztatás 4) ürítés+tisztítás 5) vízzel feltöltve vissza, csavar meghúz 6) főkapcsoló be, próbaüzem.
- **Error+80°** — láng 1 perc alatt sem gyújtott be. Felhasználó: gázcsap nyitva? más gázkészülék megy? reset 1×. Gázszag esetén: főelzáró zár, gázszolgáltató! Szakember: gáznyomás (25 mbar G20), gyújtó- és lángőr-elektróda, gázszelep kalibrálás.
- **Error+90°** — hő-korlátozó bimetál kioldott (túlmelegedés). NE reset-elgesse! Felhasználó: termofejek nyitása, nyomás 1–2 bar? Szakember: bimetál reset (manométer alatti kupak, fehér gomb), ok-keresés: keringés, lerakódás, szivattyú. Lerakódás/zárt radiátor miatti nem garanciális.
- **Error+900** — bimetál manuális reset szükséges a 90° után. Csak ha a túlmelegedés oka megszűnt; bizonytalanság esetén szakember.

## Gyakori tünetek (röviden; részletet kérdésre adj)
- Kazánzúgás/dorombolás → lerakódás a hőcserélőben, légbuborék, magas hőfok; átmosatás szakember. Lerakódás nem garanciális.
- Zajos szivattyú → levegő/lerakódás; radiátor-légtelenítés, ki-be kapcsolás (önlégtelenítő); 24 óra után szerviz.
- Nyomás 1 bar alatt → feltöltő csap LASSÚ nyitás 1 bar-ig hidegen, csap ZÁR. Heti utántöltés = szivárgás → szerviz.
- Nyomás 3 bar felett / biztonsági szelep csöpög → feltöltő csap zárva? tágulási tartály (0,8–1 bar előnyomás) szakember.
- Hideg-meleg nyomásugrás → tágulási tartály membrán; szerviz, garanciális.
- Egy radiátor hideg → felül hideg: légtelenítés; alul hideg: iszap; termofej ellenőrzés.
- Sok zárt termofej → zúgás/túlmelegedés; gépkönyv NEM javasolja a termofejeket; bypass. Ebből eredő kár NEM garanciális.
- HMV langyos (váltószelepes .V KON) → bojler-termosztát, váltószelep beragadás, vízköves csőkígyó; szerviz.
- Sötét kijelző → kismegszakító, dugó; ha külső áram OK → szerviz.
- Sav-/gázszag, CO-riasztás → AZONNAL kikapcsol, szellőztet, helyiség elhagyása, szerviz/gázszolgáltató. Életveszély!
- Gyakori le-fel kapcsolgatás → termosztát hiszterézis, földelés/polaritás (gépkönyv: vonal-nulla csere tilos!), ionizáció.
- Elmaradt éves karbantartás → garanciavesztés (1+1 év feltétele a dokumentált karbantartás).

## Kemény eszkalációs szabályok
1. Gáz-, égéstermék- vagy CO-szag → azonnali kikapcsolás + szakember/gázszolgáltató. Nincs további diagnosztika.
2. Error+70°, Error+90°, szifon-ügyek, füstgáz-visszaáramlás → szakember; a felhasználóval csak biztonságos, külső lépéseket végeztess.
3. Reset/szemrevételezés 1× próbálható — ha nem oldódik, eszkaláció.
4. Zárt égéstér megbontásával üzemeltetés TILOS és életveszélyes.

## Demo-kontextus
Ez egy bemutató: a felhasználó jellemzően az Error+70° esetet próbálja ki. Amint a hibakód kiderül (kimondja vagy kiválasztja), NE kérdezz rá még egyszer — kezdd a 6 lépéses elhárítást az 1. lépéssel (főkapcsoló ki), minden lépésnél STEP címmel, lépésenként visszajelzést kérve (OPTIONS: "Kész, következő" / "Mutasd ábrán" / "Nem találom"), a végén generálj munkalapot (SUMMARY). A 02-es képet használd az alkatrész-elhelyezkedéshez, a 03-ast a kezelőpanelhez. Az opciókhoz emoji nem kell — a felület sorszámozza őket.`;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(status, obj, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handleChat(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'invalid_json' }, cors);
  }
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return json(400, { error: 'no_messages' }, cors);
  }
  if (messages.length > MAX_MESSAGES) return json(413, { error: 'too_many_messages' }, cors);
  for (const m of messages) {
    if (typeof m?.content !== 'string' || m.content.length > MAX_MSG_CHARS) {
      return json(413, { error: 'message_too_long' }, cors);
    }
    if (m.role !== 'user' && m.role !== 'assistant') return json(400, { error: 'bad_role' }, cors);
  }

  const payload = {
    model: env.MODEL,
    max_tokens: 1200,
    system: SYSTEM_PROMPT,
    messages,
    stream: true,
  };

  let upstream;
  for (let attempt = 0; ; attempt++) {
    upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });
    if (upstream.ok) break;
    if (attempt >= 3 || (upstream.status !== 429 && upstream.status < 500)) {
      const detail = await upstream.text();
      return json(502, { error: 'upstream', status: upstream.status, detail: detail.slice(0, 300) }, cors);
    }
    await sleep(Math.min(500 * 2 ** attempt, 4000));
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...cors,
    },
  });
}

async function handleStt(request, env, cors) {
  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') return json(400, { error: 'no_file' }, cors);
  if (file.size > MAX_AUDIO_BYTES) return json(413, { error: 'audio_too_large' }, cors);

  const fd = new FormData();
  fd.append('model_id', 'scribe_v1');
  fd.append('language_code', 'hun');
  fd.append('file', file, 'audio.webm');

  const r = await fetch(ELEVEN_STT_URL, {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
    body: fd,
  });
  if (!r.ok) {
    const detail = await r.text();
    return json(502, { error: 'stt_upstream', status: r.status, detail: detail.slice(0, 300) }, cors);
  }
  const data = await r.json();
  return json(200, { text: data.text || '' }, cors);
}

async function handleTts(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'invalid_json' }, cors);
  }
  const text = body?.text;
  if (typeof text !== 'string' || !text.trim()) return json(400, { error: 'no_text' }, cors);
  if (text.length > MAX_TTS_CHARS) return json(413, { error: 'text_too_long' }, cors);

  const r = await fetch(ELEVEN_TTS_URL(env.VOICE_ID), {
    method: 'POST',
    headers: {
      'xi-api-key': env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_flash_v2_5',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!r.ok) {
    const detail = await r.text();
    return json(502, { error: 'tts_upstream', status: r.status, detail: detail.slice(0, 300) }, cors);
  }
  return new Response(r.body, {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', ...cors },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = corsHeaders(allowed ? origin : ALLOWED_ORIGINS[0]);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, cors);
    if (!allowed) return json(403, { error: 'origin_not_allowed' }, cors);

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.RL.limit({ key: ip });
    if (!success) return json(429, { error: 'rate_limited' }, cors);

    const path = new URL(request.url).pathname;
    if (path === '/chat') return handleChat(request, env, cors);
    if (path === '/stt') return handleStt(request, env, cors);
    if (path === '/tts') return handleTts(request, env, cors);
    return json(404, { error: 'not_found' }, cors);
  },
};
