# Aktieagent

En privat aktieapp för mobilen. Du kan:

- **Söka** efter vilken amerikansk aktie som helst och få:
  - graf (1 månad till 10 år) och **förväntad avkastning om 1, 3, 5 och 10 år**, med vilken aktiekurs det motsvarar. Räknas om varje minut när kursen rör sig.
  - **värdering**: rimligt värde, om aktien är under- eller övervärderad, vilken tillväxt kursen redan prisar in, och en **hype-mätare**.
  - **bolaget**: affärsidé, mål, viktiga kontrakt (från AI:n), VD, anställda och största ägare.
  - **säsongsmönster**: bästa och sämsta månader, varje år månad för månad, och vad strategin "köp i svagaste perioden, sälj i starkaste" har gett.
  - **makrokänslighet**: hur aktien brukar reagera på börsen, räntan, dollarn, oljan och inflationsoro.
- **Få en AI-bedömning.** Claude läser bolagets senaste rapport och nyheter och bedömer värdering, hype och vad som är inprisat.
- **Portfölj.** Lägg in aktierna du äger (antal och köpkurs). Du får tips per aktie – köp mer, behåll, sälj delvis eller sälj – och vid sälj förslag på aktier ur topplistorna som väntas ge mer per år. Knappen "Få AI-råd" låter Claude gå igenom hela portföljen (ungefär 1 kr).
- **Bevaka egna aktier.** Tryck på stjärnan. AI-analysen uppdateras automatiskt varje måndag.
- **Topplistor** för tre tidshorisonter: 1–6 månader, 1–3 år och 5–10 år (S&P 500, den 1:a varje månad).
- **Nya börsnoteringar** i USA det senaste året, uppdaterad varje vardagskväll.
- **Framtidsaktier**: topp 50 bolag som ännu inte är lönsamma men har bäst idéer för framtidens problem och en tydlig plan. AI bedömer idéerna. Uppdateras var 3:e månad.

Underlag för egen analys – inte finansiell rådgivning.

## Hur den är byggd

| Del | Var | Vad den gör |
|---|---|---|
| Appen | `docs/` → GitHub Pages | Det du ser i telefonen |
| Servern | `worker/` → Cloudflare Workers (gratis) | Hämtar data från Yahoo Finance, kör AI, sparar bevakningslistan |
| Topplistorna | `screener.py` + `modell.py` → GitHub Actions | Körs den 1:a varje månad |
| Nya börsnoteringar | `ipo.py` → GitHub Actions | Körs varje vardagskväll |
| Framtidsaktier | `framtid.py` → GitHub Actions | Körs 2 jan, apr, jul och okt (cirka 10 kr i AI) |

Servern skyddas av en **app-kod** som bara du känner till. Utan den kan ingen använda servern eller dina AI-krediter, även om appens adress är offentlig.

## Hemligheter i GitHub

Under **Settings → Secrets and variables → Actions**:

| Namn | Vad |
|---|---|
| `ANTHROPIC_API_KEY` | Din nyckel från console.anthropic.com |
| `APP_KEY` | En kod du hittar på själv, minst 12 tecken |
| `CLOUDFLARE_API_TOKEN` | Token från Cloudflare (mallen *Edit Cloudflare Workers*) |
| `CLOUDFLARE_ACCOUNT_ID` | Ditt konto-ID hos Cloudflare |

När de finns kör du **Actions → Uppdatera servern → Run workflow**. Servern laddas upp och appen kopplas till den automatiskt.

## Kostnad

- GitHub och Cloudflare: gratis.
- AI: ungefär 1–2 kr per analys (Claude Opus och webbsökning). En analys sparas i 7 dagar och kostar inget att visa igen.
- Inbyggt skydd: högst 25 nya AI-analyser per dag (ändras i `worker/wrangler.jsonc`).
- Säsong, makro, värdering, topplistor och nya börsnoteringar räknas med vanlig matematik och kostar inget.

## Utveckla

```bash
cd worker
npm install
node test/test.mjs         # testa servern med låtsasdata
node test/devserver.mjs    # appen på http://localhost:8787 med låtsasdata (app-kod: hemlig)
cd ..
python test_modell.py      # Python-modellen (topplistor) räknar som servern
python ipo.py --demo       # nya börsnoteringar med testdata
python test_framtid.py     # framtidsaktier: filter, AI-svar och rangordning
python framtid.py --demo   # framtidsaktier med testdata, utan AI
```

Värderingsmodellen finns på två ställen: `worker/src/analys.js` (appen) och `modell.py` (topplistorna). Ändra båda.
