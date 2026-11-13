# Aktieagent

En privat aktieapp för mobilen. Du kan:

- **Söka** efter vilken amerikansk aktie som helst och få:
  - graf (1 månad till 10 år) och **förväntad avkastning om 1, 3, 5 och 10 år**, med vilken aktiekurs det motsvarar. Räknas om varje minut när kursen rör sig.
  - **värdering**: rimligt värde, om aktien är under- eller övervärderad, vilken tillväxt kursen redan prisar in, och en **hype-mätare**.
  - **bolaget**: affärsidé, mål, viktiga kontrakt (från AI:n), VD, anställda och största ägare.
  - **säsongsmönster**: bästa och sämsta månader, varje år månad för månad, och vad strategin "köp i svagaste perioden, sälj i starkaste" har gett.
  - **makrokänslighet**: hur aktien brukar reagera på börsen, räntan, dollarn, oljan och inflationsoro.
- **Få en AI-bedömning.** Claude läser bolagets senaste rapport och nyheter och bedömer värdering, hype och vad som är inprisat.
- **Portfölj.** Lägg in aktierna du investerar i och hur stor andel av pengarna som ligger i varje (t.ex. 50 % Nvidia, 25 % Micron). Appen räknar ut portföljens förväntade avkastning per år (andel × förväntad avkastning, summerat) och visar uträkningen. Varje aktie får ett tips – köp mer, behåll, sälj delvis eller sälj – som räknas om varje gång du öppnar appen, och appen visar vilka tips som ändrats sedan förra dagen. Vid sälj föreslås aktier ur topplistorna som väntas ge mer per år. AI-genomgång på knapptryck (ca 1 kr), eller automatiskt varje vardagskväll om du slår på det (`portfolj_daglig.py`).
- **Vem äger aktien?** Andel hos institutioner, insiders och småsparare för varje aktie, och ett **ägarbetyg** (Bra / Neutral / Dålig) som också väger in om ledningen köpt eller sålt, om storägarna ökat eller minskat och hur mycket aktien är blankad.
- **Köp- och säljkurser.** I bevakningslistan, på aktiesidan och i portföljen visas för varje aktie om du bör köpa (mer), hålla, sälja en del eller sälja allt, och vid vilken kurs: köp under kursen där aktien väntas ge minst 15 % per år, sälj en del över 8 % och sälj allt över 4 % per år (3 års sikt).
- **Bevaka egna aktier.** Tryck på stjärnan. AI-analysen uppdateras automatiskt varje måndag.
- **Topplistor** för tre tidshorisonter: 1–6 månader, 1–3 år och 5–10 år (S&P 500, den 1:a varje månad).
- **Risknivå 1–10** på varje aktiesida, med skälen bakom.
- **Rapporter och djupanalys** (aktiesidan): bolagets årsrapporter fem år bakåt och en matematisk analys av dem – kassaflödesvärdering med 4 000 simuleringar (Monte Carlo), omvänd värdering (vilken tillväxt kursen kräver), Piotroskis F-score, Altmans Z-score (konkursrisk), Beneishs M-score (bokföringsvarning), DuPont och tillväxt med felmarginal. Ren matematik i `worker/src/rapport.js`, ingen AI. Gratis.
- **Algoritmen** (fliken Algoritm): en datormodell (gradient boosting, ingen AI) som tränas på 20 års kurser för S&P 500 och varje vardagskväll ger alla amerikanska aktier en poäng 0–100. Den sköter en egen portfölj med 20 aktier och fattar köp- och säljbeslut fyra gånger per år. Portföljen följs dag för dag mot S&P 500. Fliken visar också ett ärligt test (walk-forward 2010–, med avgifter) och testets svagheter. Poängen syns på aktiesidan, i bevakningen och i portföljen. Gratis.
- **Krasch-mätaren** (fliken Marknad): 17 varningssignaler (värdering, räntekurva, arbetslöshet, kreditspread, trend, bredd, rädsla m.m.) vägs ihop till en risk 0–100 med råd: köp som vanligt, köp i mindre portioner, var försiktig eller minska risken. Visar också köpläge vid rea/panik, och hur mätaren betett sig före alla ras sedan 1990. Syns som en rad överst på Bevakning och Portfölj. Gratis.

Underlag för egen analys – inte finansiell rådgivning.

## Hur den är byggd

| Del | Var | Vad den gör |
|---|---|---|
| Appen | `docs/` → GitHub Pages | Det du ser i telefonen |
| Servern | `worker/` → Cloudflare Workers (gratis) | Hämtar data från Yahoo Finance, kör AI, sparar bevakningslistan |
| Topplistorna | `screener.py` + `modell.py` → GitHub Actions | Körs den 1:a varje månad |
| Algoritmen | `algoritm.py` → GitHub Actions | Varje vardagskväll: tränar, testar, ger poäng; beslut första handelsdagen varje kvartal |
| Krasch-mätaren | `krasch.py` → GitHub Actions | Varje vardagskväll; mejlar (GitHub-ärende) när läget ändras |
| AI-uppdatering | `ai_vecka.py` → GitHub Actions | Varje måndag: nya AI-analyser för bevakade aktier äldre än 6 dagar (högst 9) |
| Portföljens AI-genomgång | `portfolj_daglig.py` → GitHub Actions | Varje vardagskväll, bara om påslagen i appen |

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

## Algoritmen – vad den är och inte är

- **Modell:** sex gradient boosting-modeller (tre inställningar × 3 och 6 månaders sikt) på 18 mått från kurser och handel. Målet är rensat från börsens och branschens rörelse, så modellen letar efter aktier som går bättre än sina likar.
- **Test:** walk-forward från 2010. Modellen tränas bara på data före varje testår. 0,3 % avgift per affär. Rätt historiska medlemmar i S&P 500 används ([fja05680/sp500](https://github.com/fja05680/sp500)).
- **Resultat:** ungefär som index. Portföljen gick i testet någon procentenhet bättre per år än S&P 500, med större ras. Träffsäkerheten för enskilda aktier är inte statistiskt säker.
- **Svagheter:** bolag som köpts upp eller gått i konkurs saknas hos Yahoo (testet blir för snällt), flera varianter har prövats, och modellen ser bara kursdata – inte rapporter eller värdering.
- **Skydd mot fusk** (`test_algoritm.py`): ren slump ger ingen vinst, inga framtida kurser läcker in i faktorer eller träning, handel räknas på ojusterad kurs, fel bolag under gamla kortnamn sorteras bort.

Algoritmen är ett underlag bland flera, inte ett facit.

## Kostnad

**All AI är avstängd just nu** (`AI_AV: "1"` i `worker/wrangler.jsonc`). Appen drar då inga krediter. Slå på igen: ändra till `"0"` och kör "Uppdatera servern". Måndagsuppdateringen och portföljens dagliga AI-genomgång körs bara manuellt, och topplistan görs utan AI.

- GitHub och Cloudflare: gratis.
- AI: ungefär 1–2 kr per analys (Claude Opus och webbsökning). En analys sparas i 7 dagar och kostar inget att visa igen.
- Inbyggt skydd: högst 25 nya AI-analyser per dag (ändras i `worker/wrangler.jsonc`).
- Säsong, makro, värdering och topplistor räknas med vanlig matematik och kostar inget.

## Utveckla

```bash
cd worker
npm install
node test/test.mjs         # testa servern med låtsasdata
node test/devserver.mjs    # appen på http://localhost:8787 med låtsasdata (app-kod: hemlig)
cd ..
python test_modell.py      # Python-modellen (topplistor) räknar som servern
python krasch.py --demo    # krasch-mätaren med testdata
python test_algoritm.py    # algoritmen: inget fusk med framtida data, portföljens regler
python algoritm.py --demo  # algoritmen med testdata
```

Värderingsmodellen finns på två ställen: `worker/src/analys.js` (appen) och `modell.py` (topplistorna). Ändra båda.
