# Using Salesforce as the source for a Harbor marketing audience

Salesforce remains the system salespeople update. Harbor copies the fields a marketing operator selects into the configured workspace. Daily operations such as editing a Salesforce Contact or Contract stay in Salesforce.

## Set up a sandbox connection

1. In Salesforce Setup, create an external client app, enable OAuth with API access, enable the client credentials flow, and assign a dedicated execution user under its policies. Give this user access to the **full population used for consent**, including opted-out and duplicate Contacts, the selected Accounts, and the related objects and fields. An integration account that sees only a prefiltered opted-in list could hide an opt-out on a duplicate Contact. [Salesforce external app setup](https://help.salesforce.com/s/articleView?id=sf.configure_client_credentials_flow_for_external_client_apps.htm&language=en_US) · [Execution user policy](https://help.salesforce.com/s/articleView?id=sf.policies_configure_client_credentials_flow_for_external_client_apps.htm&language=en_US&type=5)
2. Select a Contact checkbox that means someone affirmatively agreed to the campaign's type of email. Verify what sets that checkbox in your org. Harbor additionally reads Contact.Id, Email, AccountId and HasOptedOutOfEmail. Account fields and one related object are configurable for the installation. For a standard Salesforce Contract, choose object `Contract` and lookup `AccountId`. For a custom contract object, use its actual object and Account lookup API names.
3. Set the following variables in the Harbor server or operator's secret store. Set the marketing workspace using the installation's marketing setup guide. Only the application server or operator running a refresh needs the credentials.

| Setting | Value |
| --- | --- |
| `HARBOR_SALESFORCE_ORIGIN` | The org's My Domain HTTPS origin, e.g. `https://fictional-harbor.my.salesforce.com` |
| `HARBOR_SALESFORCE_CLIENT_ID` | External client app consumer key |
| `HARBOR_SALESFORCE_CLIENT_SECRET` | External client app consumer secret |
| `HARBOR_SALESFORCE_API_VERSION` | Optional, defaults to `v64.0` |
| `HARBOR_SALESFORCE_AUDIENCE_MAPPING` | One JSON object as illustrated below, using exact API names |

```json
{
  "consentField": "Marketing_Opt_In__c",
  "accountFields": ["Industry", "Customer_Tier__c"],
  "related": {
    "object": "Contract__c",
    "accountField": "Account__c",
    "fields": ["State__c", "Product_Family__c"]
  }
}
```

Remove `related` for an account-only installation. The connector supports up to 12 scalar fields per object and up to 4,096 characters per value. It reads each of Accounts, related objects and Contacts through Salesforce's regular REST query and follows the org's query locators. The requested page size is 500. Larger text, compound values, inaccessible fields or an incomplete response stop the refresh. [Salesforce query pagination](https://developer.salesforce.com/blogs/2022/12/processing-large-amounts-of-data-with-apis-part-1-of-2)

## Bring over old unsubscribes

Before enabling marketing delivery, export only the addresses marked unsubscribed in your previous tool. An export of all contacts would block every address it contains. Keep the CSV on the operator's machine or inside its command container. Include one `Email` or `Email address` column. Quoted fields, additional columns, UTF-8 with a byte-order mark, CRLF and embedded line breaks are supported.

```sh
node scripts/portable-web.mjs marketing suppression-preview ./unsubscribed.csv
node scripts/portable-web.mjs marketing suppression-import ./unsubscribed.csv SHA256_FROM_PREVIEW
```

Check the workspace ID and the counts for distinct addresses, existing opt-outs and new opt-outs before applying. Harbor checks that the file still matches the preview, then marks those addresses permanently unsubscribed. Existing manual blocks become recipient opt-outs. For a newly imported opt-out, Harbor records the time of import. Repeating the import preserves that timestamp and any earlier Harbor recipient confirmation. An invalid row or a changed file leaves existing suppressions intact. The import accepts up to 250,000 records and 64 MiB per file. Keep the original source export as your evidence of what the prior system recorded.

## Return opt-outs to Salesforce

After a complete refresh, run `node scripts/portable-web.mjs marketing suppression-export ./salesforce-opt-outs.csv` using a **new** filename on a local filesystem that supports hard links. Harbor creates an owner-only file after the export succeeds. Check the workspace, snapshot, number of matching Contacts and unmatched addresses in the summary. A confirmed Harbor opt-out can match several Salesforce Contacts that share an email. Harbor includes every matching Contact ID. The CSV contains only `Id` and `HasOptedOutOfEmail`, with `TRUE` on every row. Manual workspace blocks are excluded. If any addresses are unmatched, keep them blocked in Harbor and review the source organization's Contacts before the next export.

A Salesforce administrator can use an **Update** import for **Contact**, map `Id` as the Salesforce record ID and `HasOptedOutOfEmail` as the email opt-out field, review the preview, and inspect the result in the same Salesforce organization as the refresh. Generating the private CSV makes zero Salesforce changes. The operator should keep this file with the business's import evidence.

## Qualify an audience

Run a full refresh and compare Harbor's count with Salesforce using fictional records first. A refresh replaces the previous snapshot, including removing records that disappeared. Allowable recipients have a valid email, positive checkbox consent, and a false Salesforce opt-out. Duplicate addresses count once, and any conflicting consent on another Contact with the same normalized email excludes the address. The workspace's current do-not-email list also excludes addresses. Form submission on its own grants no consent.

An audience may match one Account field and one related-object field together. Values match exactly, including case. At least one related row must match **on the same Account as the Contact**. A missing relationship cannot satisfy a related criterion. Harbor pages the preview 25 addresses at a time and calculates the total in PostgreSQL.

Harbor closes the audience during each refresh, after a failed run, and 24 hours after a refresh started. A successful refresh reopens it. A stopped run with no progress for five minutes can be replaced. Salesforce changes after a scan become visible on the next refresh. Refresh immediately before a campaign if consent may have changed. Salesforce uses a separate query for each object, so its records can change between those reads.

## Local qualification

The focused test uses a synthetic Salesforce OAuth and query provider. Its PostgreSQL portion uses a fresh child database against the repository's disposable `HARBOR_TEST_POSTGRES_URL` fixture. Run from the repository root with `node --test tests/portable-marketing-audience.test.mjs`. The database portion reports as skipped when the fixture is absent.

The fixture contains 70,000 Contacts, 31,000 initially marketable addresses, 2,000 Accounts and 2,000 related contract records. It checks cross-object counts and pagination, workspace isolation, opt-outs from an unselected Account, Harbor suppression, deleted Contacts, failed or concurrent refreshes, and stale data. On a local PostgreSQL 18 instance, the refresh took 2.25 seconds across 148 simulated provider query pages. Exactly 2,589 eligible addresses matched both the healthcare Account criterion and an active contract; an unrestricted preview and two filtered pages together took 248 ms. These timings exclude Salesforce network latency. A customer sandbox is still needed to check field permissions, freshness, quota use and sync time in that org.
