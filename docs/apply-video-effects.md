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
- Durata estimată a ieșirii (după viteză): maximum 120 secunde.
- Dimensiunea descărcării: `MAX_DOWNLOAD_BYTES` (implicit 200 MB). Timeout: `JOB_TIMEOUT_MS` (implicit 300 s).
- Maximum 16 segmente.

## Reguli pentru `video_url`

- Doar `http` și `https`, porturi standard, fără credențiale în URL.
- Fiecare hop: DNS se interoghează o singură dată. Toate adresele rezolvate trebuie să fie publice; adresele private, loopback, link-local (inclusiv metadata 169.254.169.254) și IPv6 echivalente (inclusiv IPv4-mapped) sunt blocate.
- Conexiunea e fixată (pinned) pe prima adresă validată: lookup-ul din request întoarce mereu adresa validată, fără a doua rezoluție DNS. TLS folosește hostname-ul original (SNI și verificare certificat).
- Fiecare redirect e tratat manual: ținta nouă e validată și fixată separat înainte de cerere. Maximum 3 redirecturi.
- Doar conținut `video/*` pentru acest tool.
- Erorile nu includ URL-ul complet (query-ul semnat rămâne privat).

## Eșecuri și curățare

- Directorul de descărcare al sursei e șters în `finally`, la succes și la eșec.
- La eșec (ffmpeg, probe, dimensiuni, sunet în ieșire, durată în afara toleranței) directorul de ieșire e șters.
- La succes ieșirea e păstrată pentru upload.

## Validarea ieșirii

- Dimensiunile trebuie să fie identice cu sursa.
- Ieșirea nu are audio.
- Durata trebuie să fie în ±0.1 s față de durata estimată din segmente. Ieșirile trunchiate nu trec.

## Limite de procesare

- Încetinirea nu interpolează cadre: ritmul e mai lent, dar fără cadre generate.
- `fps` nu schimbă viteza mișcării; schimbarea de viteză e doar prin `speed`.

## Testare

- `npm run test:unit`: validare, argumente ffmpeg, curățare la eșec, validare durată, reguli URL cu DNS și transport mock (fără rețea reală, fără adrese private contactate, inclusiv test de rebinding și redirect pinning).
- `npm run test:smoke`: render real pe un fișier. Rulează doar cu `FFMPEG_FIXTURE=/cale/sursa.mp4`; altfel e sărit.
- `npm run typecheck`, `npm run build` și `npm run test:client` rulează în mediul de deploy.

Alte tool-uri (`concat_clips`, `add_audio`, `trim_clip` etc.) folosesc încă descărcarea veche și nu beneficiază de aceste reguli în acest PR.
