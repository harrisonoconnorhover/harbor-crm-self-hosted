# Run email marketing alongside Salesforce

Use this option when salespeople should keep working in Salesforce and the marketing team needs email design, audience selection and website forms. The portable Harbor app provides one owner-managed marketing workspace per installation. Salespeople can continue to use their existing Salesforce records. Harbor keeps a marketing copy of selected fields in PostgreSQL.

## Set up a rehearsal

1. Install the [portable app](self-host.md) and apply its database migrations. Use the workspace ID shown in **Workspaces** or its workspace URL. Set `HARBOR_MARKETING_WORKSPACE_ID` in the web service and in the environment used for the marketing commands. Open **Marketing → Email marketing** as the workspace owner.
2. Connect a Salesforce sandbox and map a **positive consent checkbox**, Account fields, and optionally one related standard or custom object with an Account lookup. For a migration from another email service, preview and import its existing opt-outs before the first campaign. A missing consent value excludes the address. An opt-out on a duplicate Contact also excludes it when the duplicate belongs to another Account. [Salesforce mapping and opt-out import](marketing-salesforce.md)
3. Open **Email designs → New design** to use Harbor's built-in designer. Start with a blank layout, newsletter or announcement. Set a brand color, add text, a linked button or an image with alt text, and rearrange the blocks. Images use public HTTPS URLs readable by recipients. Check the desktop and mobile previews, enter a subject and save. Harbor generates HTML and plain text from the same layout. Preview a fictional message in your team's actual inboxes before sending a campaign.
4. Run the Salesforce sync, then open **Campaigns**. Choose an Account field and, if needed, a field on a related contract. **Preview eligible recipients** shows the distinct count and a sample. A campaign name and saved design are required to queue it. Optionally set the earliest send time in your local time zone. Queuing freezes the email content and recipient list. The operator can run delivery later.
5. In **Forms**, enable an inquiry form and copy its embed into Webflow or WordPress. In **Email marketing → Website forms**, select the internal recipients and enable the Salesforce destination for that form. New inquiries and their delivery instructions are saved together. An inquiry alone grants no marketing consent. [Website embeds, routing and Salesforce field mapping](marketing-forms.md)

Teams with existing Beefree templates can select **Import Beefree design**, or **Use Beefree** when the licensed editor is connected. Harbor keeps the original editable Beefree project. Both types of design appear in the same campaign picker. [Beefree setup and imports](marketing-beefree.md)

## Sender configuration

Use a dedicated verified sending domain. Harbor's adapter submits one message per address through Resend's Email API and records its provider ID. Configure the following in your installation's private environment. Use a test sender and controlled mailboxes for the first real run. [Email API](https://resend.com/docs/api-reference/emails/send-email)

| Setting | Where it is needed |
| --- | --- |
| `HARBOR_MARKETING_WORKSPACE_ID` | Web and marketing operator. Bind both to the same workspace. |
| `HARBOR_BEEFREE_CLIENT_ID`, `HARBOR_BEEFREE_CLIENT_SECRET` | Optional web credentials for the Beefree editor. The built-in designer and paired Beefree imports work without these settings. |
| Salesforce OAuth and audience mapping | Marketing operator. The form routing screen also uses the nonsecret origin and form mapping. |
| `HARBOR_MARKETING_FORM_RECIPIENTS` | Web and marketing operator. List permitted internal addresses, separated by commas. |
| `HARBOR_RESEND_API_KEY`, `HARBOR_MARKETING_FROM` | Marketing operator. Use a domain-scoped sending key and a single verified sender address. |
| `HARBOR_MARKETING_POSTAL_ADDRESS`, `HARBOR_LOGIN_ORIGIN` | Marketing operator. The footer includes this address and an unsubscribe URL on the public HTTPS Harbor origin. |
| `HARBOR_RESEND_WEBHOOK_SECRET` | Web and marketing operator. Set the signing secret for `<Harbor origin>/api/marketing/feedback`. Subscribe to `email.delivered`, `email.suppressed`, `email.bounced` and `email.complained`. |
| `HARBOR_MARKETING_DELIVERY_ENABLED=true` | Only the process explicitly running marketing delivery. The ordinary Notes worker does not process campaigns or form deliveries. |

Keep tokens and unsubscribe URLs out of access logs. Inbound feedback is signature-checked. A confirmed complaint or permanent bounce blocks that address in the workspace. Each message includes visible and one-click unsubscribe links. Verify DKIM on an actually received message, including coverage of the unsubscribe headers, and exercise the provider's signed webhook before opening the audience. [Bulk sender requirements](https://resend.com/blog/gmail-and-yahoo-bulk-sending-requirements-for-2024) · [One-click unsubscribe](https://www.rfc-editor.org/rfc/rfc8058.html)

## Operate the queue

Run these inside the portable release image with the marketing operator's environment and database connection. Configure the same public HTTPS Harbor origin on the worker as on the web app. With separate PostgreSQL roles, the marketing operator needs read/write access to the marketing tables and email preferences, inquiry/form reads, workspace locking and temporary tables for the opt-out import. Web form admission needs route reads and delivery inserts when the workspace is enabled. The web role also needs SELECT on `portable_marketing_mail_cooldown` so the owner can see the earliest retry time in **Delivery activity**.

```sh
node scripts/portable-web.mjs marketing sync
node scripts/portable-web.mjs marketing status
node scripts/portable-web.mjs marketing deliver 100
node scripts/portable-web.mjs marketing forms-run 20
node scripts/portable-web.mjs marketing forms-status
```

To carry confirmed Harbor opt-outs back into Salesforce, run `node scripts/portable-web.mjs marketing suppression-export NEW_FILE.csv` against a fresh audience. Review the matched and unmatched counts, then update Contacts by ID with Salesforce Data Loader. The CSV only sets the opt-out flag to true. Harbor blocks unsubscribed addresses immediately. [Consent migration and reconciliation](marketing-salesforce.md)

The `deliver` and `forms-run` commands process up to 100 actions per invocation. To run unattended, schedule the sync and the two delivery commands with your host's scheduler. Run the sync at least once per day and immediately before the first campaign or after material Salesforce consent changes. One example is a six-hourly sync and one delivery pass per minute. Choose a frequency within the sending plan's quota. No schedule is installed by Harbor. In an existing Docker Compose installation, the marketing operator can run the same release image with its own environment file.

### Sending a larger campaign

For a queued, activated campaign, use `marketing drain` to overlap provider requests. Set the rate to the share of your provider quota available to Harbor. The following example starts up to two requests per second, allows four outstanding requests and runs for up to five minutes before it stops claiming work.

```sh
node scripts/portable-web.mjs marketing drain --limit 1000 --rate 2 --concurrency 4 --seconds 300
```

| Option | Default | Allowed range |
| --- | ---: | ---: |
| `--limit` (recipient checks) | 100 | 1–100,000 |
| `--rate` (starts per second for an exclusive drain) | 2 | 1–100 |
| `--rate-slots` (share for a cooperating drain) | Off | Inclusive range within 1–100, such as `1-2`. Choose this or `--rate`. |
| `--concurrency` (outstanding passes) | 1 | 1–32 |
| `--seconds` (time to start work) | 60 | 1–3,600 |

The output includes counts by outcome, elapsed time and why the run stopped. A time limit or shutdown signal allows outstanding requests to finish and record their receipts. An uncertain send stops new claims in that run and appears under **Delivery activity** for investigation. Later runs can process other recipients. After an HTTP 429, later commands honor the stored provider cooldown for both campaign and form email. `marketing status` reports the earliest retry time in Unix milliseconds as `providerRetryAtMs`, or `null` once the cooldown clears. Ordinary delivery commands run exclusively. An overlapping command reports `operator_busy` and exits. To process inquiries during a campaign, reserve separate rate slots for its form worker.

In **Marketing → Campaigns → Delivery activity**, **Older campaigns** lets you find and pause a campaign after it leaves the first 25. Under **Needs a decision**, use **More delivery issues** to investigate later entries while leaving earlier ones open. The two lists page independently. Refreshing, pausing a campaign or recording a decision keeps your place. **Close without resending** removes that recipient from the review queue.

### Run a campaign across worker replicas

Use the same release and PostgreSQL database on each replica. Divide the provider rate budget available to Harbor into numbered slots. Each slot allows one request start per second. For example, if Harbor has a budget of five starts per second, run the first command on one replica and the second on another:

```sh
node scripts/portable-web.mjs marketing drain --rate-slots 1-2 --concurrency 4 --limit 1000 --seconds 300
node scripts/portable-web.mjs marketing drain --rate-slots 3-5 --concurrency 6 --limit 1500 --seconds 300
```

Both replicas claim distinct recipients from the same queue. The first can start two requests per second and the second can start three. Each has its own limit and shutdown deadline. Starts from different replicas can coincide. Allocate the slots to fit your actual provider quota, including other applications using it. PostgreSQL refuses overlapping slot ranges and keeps exclusive delivery commands out until the last replica finishes. Each command holds a database session for its locks, so use a direct connection or session pooling. When a replica exits, PostgreSQL releases its slots. A replacement can claim pending recipients. A send interrupted before its receipt was saved goes to **Delivery activity** for investigation after its lease expires. Other replicas can keep working on the remaining recipients.

When a worker detects that its database connection closed, it stops starting deliveries. If it had claimed a campaign email or form notification but had not called the provider, it returns the item to the queue with its previous attempt count. A replacement can use the released slots. Requests already handed to the provider can still finish and save a receipt. If their outcome is unknown, check **Delivery activity** before retrying. The provider can briefly see overlapping traffic during a handoff, particularly before the old worker detects the disconnect. Its rate limit and Harbor’s shared cooldown still apply.

For a shared budget of five starts per second, a sales team could assign slots `1-4` to a campaign and keep slot `5-5` for new inquiries. Run these on separate workers and size the ranges for your provider account.

```sh
node scripts/portable-web.mjs marketing drain --rate-slots 1-4 --concurrency 4 --limit 1000 --seconds 300
node scripts/portable-web.mjs marketing forms-run 20 --rate-slots 5-5
```

The form worker checks its own queue and handles one action at a time. An overlapping range returns `operator_busy` before either worker can use the same slots. A provider cooldown pauses new email from both queues. The form worker can still process an eligible Salesforce action during that cooldown.

To reserve capacity for a second workspace on the same database, give its worker a separate range and its own `HARBOR_MARKETING_WORKSPACE_ID`, sender and campaign settings. A busy workspace cannot claim another running worker’s range. Start both workers to use both allocations. Harbor does not automatically assign unused slots. A provider slowdown applies across both workspaces. Requests already in flight can finish, and new sends resume after the cooldown and any recipient-specific retry delay. Each web process and feedback endpoint still serves one configured marketing workspace. Route each workspace’s feedback to its matching endpoint.

In **Marketing → Campaigns → Delivery activity → Recipient history**, enter the recipient’s full email address to see their campaigns, latest delivery states, attempt counts and saved provider message IDs. Choose **Older deliveries** for earlier campaigns. The lookup uses Harbor’s existing receipts. It sends no mail. A queued recipient can have zero attempts, and an accepted message is still awaiting delivery feedback.

If a worker stops mid-send, open **Marketing → Campaigns → Delivery activity → Needs a decision**, or run `marketing status`. Refresh after the two-minute confirmation window. The overdue attempt appears even with every sender stopped. Check the recipient and time against the provider’s records. Use **Verify receipt** to save a confirmed message ID or **Close without resending** to end the attempt. Reading this list and recording a decision both leave sending off.

When a worker finds an expired send with no confirmation, it places the recipient on hold as **uncertain**. A later acknowledgment for the same attempt can record the provider message ID. If signed delivery feedback or an operator has already settled the attempt, the worker reports that saved outcome when its own request finishes.

**Delivery activity** distinguishes queued, accepted by the provider, delivered, skipped and uncertain outcomes. A suppressed receipt means the provider withheld that message. It leaves the recipient’s consent unchanged. A confirmed unsubscribe excludes the address from future campaign queues. You can also pause a campaign. A pause affects future claims. A send already in flight can complete. Dispatch checks the latest completed Salesforce snapshot and current Harbor opt-outs. A failed or stale sync suspends dispatch. Changing Salesforce org or field mapping holds prior campaigns for a new review. Salesforce changes between scans appear at the next successful refresh.

When a provider request times out or a worker stops mid-send, investigate the recipient and time in the provider. Record the provider's message ID or close the item without resending. A definite rate-limit rejection gets a bounded retry with backoff. Restoring a Harbor backup preserves delivery receipts and removes campaign and form dispatch authorizations. Reconcile any sends since the backup with the provider before creating a new campaign. [Form delivery decisions](marketing-forms.md)

## Volume and budget

At 31,000 eligible addresses, a monthly campaign to the whole list means 372,000 sends per year. A weekly campaign means about 1.61 million. A $6,500 annual budget allows about $542 per month for sending, hosting, backups, Salesforce API access and operator time. Harbor's built-in designer has no separate editor fee. If the team chooses Beefree SDK Essentials at its listed $400 per month, about $142 per month remains for those other costs. A team that already uses Beefree can also bring paired exports if its plan includes both files. [Beefree SDK pricing](https://developers.beefree.io/pricing-plans) · [Resend pricing](https://resend.com/pricing)

The local rehearsal used PostgreSQL 18 with 70,000 fictional Contacts, including 31,000 marketable addresses. The Account and contract filters selected 2,589. The built app separately queued 31,000 recipients and tested blocking, duplicate queue requests, pause, provider failures, unsubscribe and signed feedback. For a customer pilot, verify the real Salesforce permissions and totals, both published website embeds, internal notifications, Salesforce receipts, and inbox placement and rendering with a controlled seed list. Qualify the licensed Beefree editor only if the team uses it. Existing form limits are 30 inquiries per form per rolling hour and 100 per workspace per UTC day. Compare those with actual peak form traffic. [Scale fixture](../tests/portable-marketing-audience.test.mjs) · [Campaign rehearsal](../tests/portable-marketing-campaign.test.mjs)

From a source checkout with the normal build dependencies, the fixture dependencies and PostgreSQL 18 client tools installed, run `npm run test:marketing:portable` to repeat the local rehearsal. It starts a disposable loopback database and uses simulated providers.

A separate local dispatch rehearsal ran all 31,000 queued recipients against a simulated provider with a 120 ms response time. At a ceiling of 100 starts per second and 16 outstanding passes, Harbor finished in 7 minutes 52 seconds. After reconnecting to PostgreSQL, the rehearsal found 30,999 distinct provider receipts and one mid-campaign opt-out skipped before dispatch. Observed throughput was 65.6 acceptances per second, with at most 10 requests in flight. A repeat with late acknowledgment handling took 8 minutes 15 seconds (62.6 acceptances per second) with the same 30,999 distinct receipts and one skipped opt-out. The earlier sequential command averaged 1.6 per second on a 100-recipient sample with the same response time. Production throughput and inbox delivery depend on the provider, quota, host and workload. Repeat the full local run with `node tests/portable-fixtures/campaign-drain-load.mjs 31000`. [Dispatch rehearsal](../tests/portable-fixtures/campaign-drain-load.mjs)

A two-process rehearsal split the same 100-starts-per-second budget evenly. With a simulated 120 ms provider response, the overdue-confirmation release recorded 15,497 acceptances per process in 408 seconds during the parallel drain. The operator could see the interrupted send while the workers were stopped. Across the full 31,000-recipient scenario, PostgreSQL retained 30,997 distinct receipts. Two interrupted sends stayed on hold, one suppressed recipient was skipped, and no address received a second attempt. Reproduce locally with `node tests/portable-fixtures/run.mjs --campaign-replicas`.
