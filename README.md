# Aktieagent

En AI-agent som analyserar aktier och ger en bedömning: **Köpvärd**, **Avvakta / bevaka** eller **Undvik just nu**.

## Så fungerar den

1. **Hämtar data** från Yahoo Finance: kurs (2 år), nyckeltal, årsrapporter och nyheter.
2. **Räknar** ut en poäng 0–100 inom fem områden:

   | Område | Vikt | Exempel på vad som mäts |
   |---|---|---|
   | Värdering | 25 % | Forward P/E, PEG, P/S, EV/EBITDA, uppsida mot riktkurs |
   | Tillväxt | 25 % | Omsättnings- och vinsttillväxt, CAGR |
   | Lönsamhet | 20 % | Brutto- och rörelsemarginal, ROE, FCF-yield |
   | Finansiell styrka | 15 % | Skuld/eget kapital, current ratio, kassa/skuld |
   | Trend & risk | 15 % | Kurs mot SMA200, 6-månaderstrend, RSI, volatilitet, drawdown |

3. **AI-agenten** (Claude) får verktyg för att hämta datan och väljer själv vad den tittar på. Sedan lämnar den betyg, säkerhet, styrkor, risker och vad du ska bevaka.
4. **Sparar** en HTML-rapport med kursgraf som du öppnar i webbläsaren.

## Installera (en gång)

```bash
pip install yfinance anthropic matplotlib pandas numpy
```

För AI-delen behöver du en API-nyckel från console.anthropic.com:

```bash
# Mac/Linux
export ANTHROPIC_API_KEY="sk-ant-..."
# Windows (PowerShell)
$env:ANTHROPIC_API_KEY="sk-ant-..."
```

## Kör

```bash
python aktieagent.py NVDA                 # en aktie
python aktieagent.py NVDA BE RXRX SYM     # flera
python aktieagent.py NVDA --no-ai         # bara regelpoäng, gratis
python aktieagent.py NVDA --demo          # testdata utan internet
python aktieagent.py NVDA --out nvda.html # välj filnamn
```

Byt modell med `AKTIEAGENT_MODEL` (standard: `claude-opus-5-5`).

## Screener – rangordna alla aktier

`screener.py` går igenom många aktier och rangordnar dem efter förväntad avkastning de närmaste 12 månaderna.

**Steg 1 (gratis):** Alla aktier får en förväntad avkastning och en kvalitetspoäng.
**Steg 2 (AI):** Claude djupanalyserar de 10 bästa.

Förväntad avkastning byggs av tre delar:

| Del | Vikt | Vad det är |
|---|---|---|
| Analytiker | 50 % | Uppsida mot snittriktkursen (minst 3 analytiker) |
| Fundamenta | 35 % | Vinstavkastning (1 / forward P/E) + förväntad tillväxt |
| Trend | 15 % | Kursutveckling senaste året, nedskalad |

```bash
python screener.py                              # S&P 500 (~500 aktier, ca 5–10 min)
python screener.py --universe nasdaq100
python screener.py --universe all               # alla på NYSE + Nasdaq (~5 000, ca 1 timme första gången)
python screener.py --universe all --max-price 10 --min-mcap 100e6   # småbolag under $10
python screener.py --sort riskjusterad          # avkastning delat med volatilitet
python screener.py --ai-top 0                   # ingen AI, helt gratis
python screener.py --tickers-file min_lista.txt # egen lista
```

**År för år:** Perioden följer kalendern automatiskt. Kör du programmet 2027 rangordnar det för 2027–2028, och 2028 för 2028–2029. Fundamenta-delen använder analytikernas vinstprognos för nästa år och tillväxten från i år till nästa år. Rapporten heter till exempel `aktieranking_2027-2028.html`.

**Utvärdera i efterhand:** Varje körning sparar topp 50 med startkurs i mappen `historik/`. Ett år senare kör du:

```bash
python screener.py --utvardera
```

Då ser du förväntad och faktisk avkastning per aktie, samt om listan slog S&P 500. Så får du veta om modellen fungerar.

**Sortering:** `kombinerad` (standard) väger förväntad avkastning och kvalitet lika. `avkastning` tar bara förväntad avkastning. `riskjusterad` delar med volatiliteten.

**Resultat:** `aktieranking.html` (klicka på rubrikerna för att sortera) och `aktieranking.csv` (alla rader, öppnas i Excel).

**Cache:** Nyckeltal sparas i `.cache/` per dag. En andra körning samma dag går därför mycket snabbare.

## Bra att veta

- **Regelpoängen gynnar lönsamma bolag.** Bolag utan vinst (t.ex. tidig biotech) får låg poäng på lönsamhet och värdering. Det betyder inte att de är dåliga, bara att modellen inte kan värdera framtida potential. Där är AI-bedömningen viktigare.
- **Gränsvärdena** finns i funktionen `score()`. Ändra dem om du vill vara strängare eller mildare.
- **Datan kommer från Yahoo** och kan ibland saknas eller vara fel. Kontrollera viktiga siffror i bolagets egen rapport.
- Det här är ett verktyg för egen analys, inte finansiell rådgivning.

## Automatisk körning i Windows

Lägg alla filer i en egen mapp, till exempel `Dokument\aktieagent`. Högerklicka i mappen, välj **Öppna i terminal** och kör:

```powershell
powershell -ExecutionPolicy Bypass -File .\installera_schema.ps1
```

Skriptet installerar paketen, sparar din API-nyckel och lägger in två körningar i Schemaläggaren:

| Vad | När | Ungefärlig kostnad med Opus |
|---|---|---|
| Bevakningslistan (`bevakningslista.txt`) | Varje måndag 08:00 | ca 14 kr per gång |
| Screenern, S&P 500 med AI på topp 10 | En gång i månaden | ca 10 kr per gång |

- Är datorn avstängd vid tidpunkten körs det nästa gång den startar.
- Rapporterna hamnar i mappen `rapporter`, med datum i filnamnet. Eventuella fel loggas i `rapporter\logg.txt`.
- Vill du ändra vilka aktier som bevakas redigerar du `bevakningslista.txt` i Anteckningar.
- Ta bort de schemalagda körningarna med `avinstallera_schema.ps1`.
- Datorn måste vara påslagen och du måste vara inloggad för att körningarna ska starta.

## Mobilapp via GitHub (körs i molnet)

GitHub kör analyserna åt dig och publicerar en app som du lägger på telefonens hemskärm. Datorn behöver inte vara på. Det är gratis, du betalar bara AI-delen som vanligt.

### Engångsinstallation (ca 10 min, enklast från datorn)

1. **Skapa ett konto** på github.com om du inte har ett.
2. **Skapa ett repo:** Klicka på **+** uppe till höger och välj **New repository**. Döp det till `aktieagent`, välj **Public** och klicka **Create repository**.
3. **Ladda upp filerna:** Klicka på länken **uploading an existing file**. Dra in *allt* från den uppackade mappen, även mappen `.github`. Klicka **Commit changes**.
4. **Lägg in API-nyckeln:** Gå till **Settings → Secrets and variables → Actions → New repository secret**. Skriv `ANTHROPIC_API_KEY` som namn och din nyckel som värde.
5. **Provkör:** Gå till fliken **Actions** och godkänn om det efterfrågas. Välj **Aktieagent → Run workflow**, välj **båda** och klicka **Run workflow**. Det tar cirka 10–15 minuter.
6. **Slå på appen:** Gå till **Settings → Pages**. Under *Build and deployment* väljer du **Deploy from a branch**, sedan `main` och `/docs`, och klickar **Save**.
7. **Öppna appen** efter cirka en minut på `https://DITT-ANVÄNDARNAMN.github.io/aktieagent/`.

### Lägg den på hemskärmen

- **iPhone:** Öppna adressen i Safari. Tryck på dela-knappen och välj **Lägg till på hemskärmen**.
- **Android:** Öppna adressen i Chrome. Tryck på **⋮** och välj **Lägg till på startskärmen**.

### Hur den fungerar

- Bevakningslistan körs varje måndag morgon. Screenern körs den 1:a varje månad och utvärderar samtidigt tidigare listor.
- Appen visar bevakningslistan med betyg, årets topp 10, utvärderingen och ett arkiv. Tryck på en aktie för hela rapporten med graf.
- Vill du köra direkt trycker du på **Kör en analys nu** i appen. Då öppnas GitHub, där du väljer **Run workflow**.
- Byta aktier gör du genom att redigera `bevakningslista.txt` direkt på github.com (pennan uppe till höger).

### Bra att veta

- **Sidan är offentlig.** Den som har adressen kan se din bevakningslista och dina rapporter. Ingen kan se din API-nyckel, eftersom den ligger som hemlighet.
- **Kör inte både Windows-schemat och GitHub.** Då betalar du för AI-delen två gånger. Kör `avinstallera_schema.ps1` om du valt GitHub.
- **Yahoo blockerar ibland GitHubs servrar tillfälligt.** Misslyckas en körning syns det med ett rött kryss under Actions. Kör den då igen med **Re-run jobs**.
