# apply_video_effects

Aplică slow motion și/sau alb-negru pe segmente alese din timpul sursei.
Segmentele nedeclarate rămân neschimbate. Ieșirea e un MP4 nou, fără sunet,
cu aceeași rezoluție ca sursa. Sursa nu este modificată.

## Argumente

- `video_url` (string, obligatoriu): URL http sau https, cu reguli de siguranță (vezi mai jos).
- `segments` (listă, obligatoriu, max 16): fiecare segment are:
  - `start`, `end` (secunde în sursă, `0 <= start < end <= durata`)
  - `speed` (opțional, implicit 1, interval 0.25 până la 2; sub 1 înseamnă slow motion)
  - `effect` (opțional): `none` sau `grayscale`
  - `saturation` (opțional, implicit 1, interval 0 până la 2)
- `idempotency_key` (opțional).

Reguli: segmentele nu se suprapun. Se sortează după timp. Golurile dintre segmente
sunt păstrate intacte.

## Limite de resurse

- Sursa: maximum 120 secunde.
- Durata estimată a ieșirii (după viteză): maximum 120 secunde. Exemplu: 100s sursă cu `speed` 0.25 pe tot ar ieși 400s și e respinsă.
- Dimensiunea descărcării: `MAX_DOWNLOAD_BYTES` (implicit 200 MB). Timeout: `JOB_TIMEOUT_MS` (implicit 300 s).
- Maximum 16 segmente.

## Reguli pentru `video_url`

- Doar `http` și `https`, porturi standard, fără credențiale în URL.
- Doar adrese publice: IP-urile literale și toate adresele DNS rezolvate trebuie să fie publice. Adresele private, loopback, link-local (inclusiv metadata 169.254.169.254) și IPv6 echivalente sunt blocate.
- Fiecare redirect e revalidat înainte de cerere; maximum 3 redirecturi.
- Doar conținut `video/*` (sau `image/*` / `audio/*` pentru celelalte tool-uri ale serverului, nu acest tool).
- Erorile nu includ URL-ul complet (query-ul semnat rămâne privat).
- Limită cunoscută: conexiunea nu e fixată pe adresa validată; un atacator cu control DNS ar putea încerca rebinding între validare și cerere. Pentru un deploy cu cerințe stricte, rulați serverul într-o rețea de egress restricționată.

Alte tool-uri (`concat_clips`, `add_audio`, `trim_clip` etc.) folosesc încă descărcarea veche și nu beneficiază de aceste reguli în acest PR.

## Eșecuri

La orice eșec (ffmpeg, probe, dimensiuni greșite, sunet în ieșire) directorul de ieșire e șters.
La succes, ieșirea e păstrată pentru upload. Fișierul sursă descărcat e șters ca de obicei.

## Limite de procesare

- Încetinirea nu interpolează cadre: ritmul e mai lent, dar fără cadre generate.
- `fps` nu schimbă viteza mișcării; schimbarea de viteză e doar prin `speed`.
- Nu există audio în ieșire.

## Testare

- `npm run test:unit`: validare, construcție argumente ffmpeg, cleanup la eșec, reguli URL (mock DNS și fetch, fără rețea reală).
- `npm run test:smoke`: render real pe un fișier. Rulează doar cu `FFMPEG_FIXTURE=/cale/sursa.mp4` setat; altfel e sărit.
- Typecheck și build (`npm run typecheck`, `npm run build`) și `npm run test:client` trebuie rulate în mediul de deploy; nu sunt incluse în această verificare.
