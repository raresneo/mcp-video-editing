# apply_video_effects

Aplică slow motion și/sau alb-negru pe segmente alese din timpul sursei.
Segmentele nedeclarate rămân neschimbate. Ieșirea e un MP4 nou, fără sunet,
cu aceeași rezoluție ca sursa. Sursa nu este modificată.

## Argumente

- `video_url` (string, obligatoriu): URL-ul sursei, validat ca restul tool-urilor.
- `segments` (listă, obligatoriu, max 16): fiecare segment are:
  - `start`, `end` (secunde în sursă, `0 <= start < end <= durata`)
  - `speed` (opțional, implicit 1, interval 0.25 până la 2; sub 1 înseamnă slow motion)
  - `effect` (opțional): `none` sau `grayscale`
  - `saturation` (opțional, implicit 1, interval 0 până la 2)
- `idempotency_key` (opțional).

Reguli: segmentele nu se suprapun. Se sortează după timp. Golurile dintre segmente
sunt păstrate intacte.

## Limite

- Încetinirea nu interpolează cadre: ritmul e mai lent, dar fără cadre generate.
- `fps` nu schimbă viteza mișcării; schimbarea de viteză e doar prin `speed`.
- Nu există audio în ieșire.

## Testare

`npm run test:unit` rulează validarea și construcția argumentelor ffmpeg.
Testul pe fișiere reale necesită `ffmpeg` instalat și nu e inclus în suita unitară.
