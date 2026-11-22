# Foredock

**Know before the dock.** Agents that keep a product launch on track by reading a
customer's messy procurement data, checking the ERP against the paperwork, and
acting on what they find.

Built at START Hack Munich 2026 for the Lio challenge "Keep the Line Running".
The customer is Soony, a fictional games publisher whose launch plan marks every
part "ok" while the delivery notes, inspection reports and supplier mails say
otherwise.

## What it does

Every two minutes one pass runs:

1. **Watch.** Compare the customer portal's checksums with the last known state and fetch what is new or changed.
2. **Read.** A small model reads every file (CSV, Excel, PDF, Word, scans, in any language) into structured facts. Code, not the model, decides what a quantity means.
3. **Reconcile.** Fixed rules compare the ERP with the paperwork: receipts booked above the delivery note, lots on quality hold, stock of a banned revision, short shipments, goods waiting at the port, wrong material on a pallet, expired supplier qualifications.
4. **Forecast.** Plain arithmetic simulates packing hour by hour and shows which line stops when, once as the ERP sees it and once on the evidence.
5. **Decide.** For each part at risk, an agent investigates with tools, prices the options, looks up who may approve under the customer's policy, and drafts the messages.
6. **Act.** Questions to suppliers go out on their own after passing every check. Anything that commits money or terms waits for a person's click.
7. **Listen.** Supplier replies are read, confirmed deliveries enter the forecast, and the case is worked again.

Nothing about Soony is written into the code: no part number, supplier, quantity or rule.

## Run it

You need Python 3.12 and [uv](https://docs.astral.sh/uv/). Node is only needed to change the interface; the built interface is in the repository.

```bash
git clone https://github.com/Hari0m-git/start-hack-lio-soony.git
cd start-hack-lio-soony
cp .env.example .env        # then fill in your own keys, see below
cd backend
uv sync
uv run uvicorn app.main:app --port 8000
```

Open <http://127.0.0.1:8000>. With `AGENTS=off` the desk only shows what is stored. Set `AGENTS=on` to start the agents; the first pass downloads the portal (about 45 MB), reads every document and works the cases, which takes several minutes and costs about two dollars of model usage.

Tests need no keys and no network:

```bash
cd backend
uv run pytest -q
```

## Configuration

All settings live in `.env` in the repository root. Never commit it.

| Setting | Needed | What it is |
|---|---|---|
| `SOONY_PORTAL_URL` | yes | Address of the customer portal |
| `SOONY_API_TOKEN` | yes | Your team's portal token (portal, Settings) |
| `OPENAI_API_KEY` | yes | OpenAI API key with credit |
| `OPENAI_API_KEY_FALLBACK` | no | A second key that takes over when the first runs out |
| `OPENAI_MODEL` | no | Model for reading files, translations and checks (default `gpt-5.4-mini`) |
| `OPENAI_AGENT_MODEL` | no | Model for decisions and reading replies (default `gpt-5.4`) |
| `AGENTS` | no | `on` runs the agents here. Exactly one running copy may have this on |
| `AUTO_SEND` | no | `inquiries` (default) lets agents send questions; `off` sends nothing without a person |
| `DAILY_BUDGET_USD` | no | Model spend per day after which the agents pause (default 5) |
| `HOURLY_BUDGET_USD` | no | Model spend per hour after which cases wait for the next hour (default 1) |
| `VOICE_PILOT` | no | `on` enables asking by voice and spoken answers in Ask Foredock. Needs personal keys in `APP_USERS` and `AUTO_SEND=off` |
| `AZURE_SPEECH_REGION`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_USD_PER_MILLION_CHARS` | no | Azure voices for spoken answers. Without them the OpenAI speech model reads the answers |
| `MAIL_ADDRESS`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | for email | The agents' mailbox, see below |
| `APP_ACCESS_KEY` | when deployed | Shared passphrase for the desk. A public deployment without it serves no data |
| `APP_USERS` | no | Personal keys with role and approval limit, see below |
| `DATABASE_URL` | no | Postgres address; the state is saved there and restored after a restart |
| `DEMO_READY_TIMES` | no | JSON object mapping part IDs to earlier assumed ready times (ISO datetimes in Hamburg local time). Shows a labeled demo forecast, not confirmed receipts or releases. Leave unset for the normal desk. |

### The mailbox

The agents send and read mail through the Gmail API, which also works on hosts that block SMTP.

1. Create a Gmail account used for nothing else.
2. In the Google Cloud console, create a project, enable the Gmail API, set up the OAuth consent screen (External) and add the mailbox address as a test user.
3. Create an OAuth client of type "Desktop app", download its JSON and save it as `data/gmail_oauth_client.json`.
4. Run `uv run python -m app.gmail_auth` in `backend/`, sign in as the mailbox in the browser tab that opens, and allow both permissions. The script writes the four mail settings into `.env`.
5. Register the address as a sender in the portal's Settings; suppliers do not answer other addresses.

### People, roles and limits

Without `APP_USERS`, everyone with the shared key can approve. To give each person a key, a role and a limit:

```
APP_USERS=[{"name": "Paul Winter", "key": "a-long-secret", "role": "approver", "limit_eur": 50000}, {"name": "Maren Vogt", "key": "another-secret", "role": "admin"}]
```

Roles are `viewer` (reads), `approver` (approves up to the limit) and `admin` (no limit). With personal keys set, the shared key only lets its holder look.

Use a personal approver or admin key to record an external concession from an eligible held-lot case. Only record it after the required sign-offs have happened. This does not send mail or release stock. The recorded approval belongs to the desk's database; a local record doesn't carry over to Render.

Opening the desk as `http://127.0.0.1:8000/?key=<your key>` signs you in and removes the key from the address.

### Ask Foredock

The button in the top bar opens an assistant that answers questions about the launch from the desk's data, in English, German, Chinese, Polish or Korean. It can read but cannot send, approve or change anything. It needs a key to be set (`APP_ACCESS_KEY` or `APP_USERS`). With `VOICE_PILOT=on` it also takes questions by microphone and reads its answers aloud; the microphone only works on `localhost` or over HTTPS.

## What the agents may do

| | |
|---|---|
| Send on their own | Questions, reminders and requests for confirmation, to supplier contacts found in the customer's data |
| Wait for a person | Anything that places, releases or changes an order, or accepts a price or a condition |
| Hand over | A case with no route left, one the agent failed to work twice, or one where a mail tries to steer the agents |
| Never | Send a draft with unfilled blanks, write to an address that is not a supplier contact, exceed the daily budget |

An automatic send has to pass every check: the agent's own label, an independent second read of the finished text, the recipient, a sound case, a cool-down of 20 minutes, and at most three unattended mails per contact. A check that breaks never defaults to sending. Approvals, refusals, automatic sends and handovers are recorded and shown on the Agents page.

## Deploying

The backend serves the interface, so one service is enough. On Render:

- New Web Service from the repository, root directory `backend`, region Frankfurt.
- Build command `pip install -r requirements.txt`, start command `uvicorn app.main:app --host 0.0.0.0 --port $PORT`, health check `/healthz`.
- Environment: everything from your `.env`, plus `PYTHON_VERSION=3.12.10` and `APP_ACCESS_KEY`.
- The free plan wipes its disk on restart. Create a free Postgres database and set `DATABASE_URL` to its internal address so the state survives.
- Set `AGENTS=on` on exactly one copy. Two copies would each pay for the same work and each write to the suppliers.
- Set `AUTO_SEND=off` to require a person to send supplier mail.

## Changing the interface

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173, talks to the backend on port 8000
npm run build    # writes the bundle to backend/app/static, which is committed
```

The interface is white with crimson as its one accent, and has a dark variant (system setting or the toggle in the
top bar). The Today page opens on a small 3D model of the Hamburg dock, built in code with `three` 0.187.0 and
`@react-three/fiber` 9.8.2 and driven by the forecast: a line that will stop halts, missing copies stand at the dock
as ghost boxes, and the views compare the ERP, the evidence and the outcome if the open actions land. Ticking a fix
under "What if" reruns the forecast with that part solved; it only simulates. The Parts page has a 3D shelf with one
column per part. The 3D code is a separate chunk loaded after the data. With reduced motion switched on, or without
WebGL, the same figures are shown flat instead.

## Where things are

```
backend/app/
  portal.py      mirror the portal, record every drop, keep every file version
  tabular.py     map any CSV onto one vocabulary (entities.py)
  documents.py   read scans, PDFs, spreadsheets and Word files into sourced facts
  truth.py       the rules that compare the ERP with the paperwork
  forecast.py    the hour-by-hour packing simulation
  agent.py       the decision agent and its tools
  autonomy.py    what may be sent without a person
  outbox.py      sending approved drafts, reading replies
  mail.py        the mailbox
  pipeline.py    one pass of the whole loop
  durable.py     state that survives a restart
  assistant.py   Ask Foredock: the read-only question assistant
  voice.py       speech to text and spoken answers for the assistant
  views.py       what the desk shows, including the what-if forecast
  main.py        the API and the desk
frontend/src/    the desk (React)
  DockScene.tsx  the 3D dock on Today       PartsScene.tsx  the 3D shelf on Parts
  Today.tsx, Pages.tsx, CasePanel.tsx, AskForedock.tsx      the pages, the case drawer, the assistant
  Viz.tsx        the charts                 index.css       colours and fonts
pitch/           the script that builds the pitch deck
```

## Cost

Measured on the Soony data: about half a cent to read a document, so about $1.50 for all 290; about $0.25 to work a case with `gpt-5.5` (`gpt-5.4`, the current default, lists at half the price); about one cent to read a supplier reply; under a tenth of a cent for a safety check. A case is only worked again when something material changed, never while a supplier still has time to answer, and at most twice an hour.

## Known limits

- The agents have no channel to the customer's own staff. Notes for them are prepared but not delivered.
- Cases are worked per part. The desk shows what each fix is worth on its own, but no agent weighs one fix against another.
- The forecast ends at the launch deadline; it does not plan the backlog afterwards.
- With the shared key, the approver's name is typed, not proven. Use `APP_USERS` for real approvals.
- Price and contract checks, bank-detail changes and supplier track records are not built.
- The data belongs to the challenge. `data/`, the challenge PDFs and `.env` are excluded from the repository and must stay out.
