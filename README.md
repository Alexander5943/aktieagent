# Aktieagent

En privat aktieapp för mobilen. Du kan:

- **Söka** efter vilken aktie som helst och få en graf (1 månad till 5 år), nyckeltal, kvartalssiffror och nyheter.
- **Få en AI-bedömning.** Claude läser bolagets senaste rapport och nyheter på webben och säger om aktien ser köpvärd ut, och varför.
- **Bevaka egna aktier.** Tryck på stjärnan på en aktie. AI-analysen uppdateras automatiskt varje måndag.
- **Se månadens topplista:** S&P 500 rangordnad efter förväntad avkastning de kommande 12 månaderna.

Underlag för egen analys – inte finansiell rådgivning.

## Hur den är byggd

| Del | Var | Vad den gör |
|---|---|---|
| Appen | `docs/` → GitHub Pages | Det du ser i telefonen |
| Servern | `worker/` → Cloudflare Workers (gratis) | Hämtar data från Yahoo Finance, kör AI, sparar bevakningslistan |
| Topplistan | `screener.py` → GitHub Actions | Körs den 1:a varje månad |

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

## Utveckla

```bash
cd worker
npm install
node test/test.mjs         # testa servern med låtsasdata
node test/devserver.mjs    # appen på http://localhost:8787 med låtsasdata (app-kod: hemlig)
```
