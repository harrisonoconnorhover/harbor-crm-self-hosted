# Connect an integration to Harbor

In **API access**, the workspace owner can give an integration different permissions for Contacts, Companies, Deals, Tasks, Leads and Tickets. For example, let a quoting system edit Deals, read Companies and leave Contacts inaccessible. Choose **Read records and track removals** for a read-only mirror. It can read active records and learn which IDs were archived or permanently deleted. Choose **Read, create, edit and track removals** for a two-way sync that needs to leave archiving to your team. **Read, create, edit and archive** also lets the connector archive records. Existing keys retain their permissions. Harbor shows a new key once. Use it as a Bearer token from your integration server. The token belongs to the issuing owner's private workspace and expires after its selected term. Revoke it from the same screen.

Use the collection path `/api/v1/records/{object}`, where `{object}` is `contacts`, `companies`, `deals`, `tasks`, `leads` or `tickets`.

| Operation | Request | Result |
| --- | --- | --- |
| Create | POST to the collection with `{"id":"<new UUID>","properties":{"name":"Studio scanner"}}` | 201 with the record, its address and its ETag (version). Generate and save the UUID before the first attempt. A retry with that ID returns 409. |
| Read | GET the collection, or append `/{id}` for a single record | 200. Use the detail response's quoted ETag for edits. |
| Edit | PATCH `/{id}` with `{"properties":{"name":"Studio scanner demo"}}` and the `If-Match` header set to the ETag | 200 with the updated record and ETag. Omitted properties and links are preserved. |
| Archive | DELETE `/{id}` with `If-Match` and an empty body | 204. The record leaves ordinary lists and can be restored in Harbor's **Recycle Bin**. |

A missing version returns 428. A change since your last read returns 412. Fetch the record again and reconcile its values. After a lost create response, read the original ID before retrying. Each owner’s integration keys share a 60-write-per-minute allowance. A 429 response includes a retry delay. Record mutations accept JSON requests up to 64 KiB.

Record permissions cover ordinary properties. Contacts, Companies and Deals also accept permitted custom values under `properties.custom`, keyed by property ID. Team-restricted and owner-only values stay hidden from tokens and survive edits to other fields. Assignees, queues and Ticket owner are managed inside Harbor. Setting a primary company or contact requires a separate relationship permission. By keeping the same domain writers as the editor, API edits respect current stage requirements and preserve the existing record workflows. After a database restore, issue a fresh integration key in the restored workspace.

To fetch known IDs together, send `POST /api/v1/records/{object}/batch/read` with the same object's read token and JSON `{"inputs":[{"id":"record-uuid"}]}`. A batch accepts 1–50 distinct UUIDs and at most 8 KiB. Results keep input order and include the same record fields as a detail read. The server returns 207 if any item is missing, archived, a different object, or outside the token’s workspace. Those cases all use the same per-item 404. The route reads active records. Add a `properties` array to select standard fields, all readable custom values using `custom`, or individual custom fields using `custom:<UUID>`. Selected custom values are returned under `properties.custom`. The response keeps its record metadata and ETag. An empty array returns an empty `properties` object. Unset selected fields are omitted, and unsupported names fail with HTTP 400. Omitting the array retains the full response.

### Sync the records linked to a customer

In **Settings → Data management → API access**, select read access for the relevant record types and choose **Record relationships → Read relationships** when creating the key. For example, a Salesforce connector that needs the contacts for a company needs both Companies and Contacts. Existing keys keep their original permissions.

Send `GET /api/v1/records/companies/{company-id}/associations/contacts?limit=25` with the key. Contacts, Companies and Deals can be the source or target, including links between records of the same type. Each result contains a target ID and object type. An `explicit` link carries the labels saved on the relationship. `primary` means the source points to that target as its primary record. `reversePrimary` means the target points back to the source as its primary record. A contact listed as both a company's billing contact and as a contact whose primary company is that company appears once with its label and both applicable flags.

The default page size is 25 and the maximum is 50. Keep passing `next.after` as `after` until `next` is null. Fetch the target's permitted properties using its record ID. Archived targets disappear from results. An archived or missing source returns 404. Each successful GET records the source and returned target IDs in the token's access history. Rescan relationships when reconciling them, since a label change can leave record update times unchanged.

For a batch, POST to `/api/v1/associations/{sourceObject}/{targetObject}/batch/read` with the same relationship and record permissions. For example, to sync the contacts for two companies, POST this body to `/api/v1/associations/companies/contacts/batch/read`.

```json
{"inputs":[{"id":"11111111-1111-4111-8111-111111111111"},{"id":"22222222-2222-4222-8222-222222222222"}],"limit":25}
```

Send 1–50 distinct source IDs. The limit applies to each source (default 25, maximum 50). Results follow input order. Each found source has its own `results` and `next`. On the next request, include only unfinished sources and pass each one's cursor as `{"id":"…","after":"…"}`. A found source with no active links has an empty list and a null cursor. Missing, archived and other-workspace sources get the same per-item 404. HTTP 207 means to check each result. All source pages in a single request use one database snapshot. A subsequent request sees current links.

To add, edit or remove a labeled link, choose **Read and manage labeled links** and grant record edit access for both types. Send `PUT /api/v1/records/companies/{company-id}/associations/contacts/{contact-id}` with `{"labels":["Billing contact"]}`. HTTP 204 confirms the link. Repeating the same request is safe. Different labels on an existing link return HTTP 409 so you can reconcile the difference.

To replace the labels on an existing link, GET the pair at the same URL and copy its ETag. Send PUT with that ETag in `If-Match` and the complete new label list, for example `{"labels":["Decision maker","Renewal sponsor"]}`. Send `{"labels":[]}` to clear the labels and keep the association. The link keeps its identity and any primary relationship. A concurrent change returns 412. After an interrupted update, GET the pair again and compare its current labels with the intended result.

To remove a labeled link, send DELETE to that URL with its current ETag in `If-Match`. A missing precondition returns 428. A stale version returns 412. Read the pair again before retrying. When the pair also has a primary relationship, removing the explicit link preserves the primary relationship and GET still returns it. An unrelated or unavailable pair returns 404. Primary links can be edited on the record in Harbor.

### Set a primary company or contact

For a connector that owns account relationships, select **Read and manage primary links** plus edit access to each record type it will link. **Read and manage primary and labeled links** allows both operations. Previously issued keys retain their original permissions.

On a Contact, supply `primary.companyId`. On a Deal, supply `primary.companyId`, `primary.contactId`, or both. Use the same body on create and edit, including individual rows of a batch. For example, PATCH a Deal with the ETag from its last read and this body:

```json
{"properties":{"name":"Juniper renewal"},"primary":{"companyId":"cfa19409-403c-4dba-b49b-d4560004dc27","contactId":null}}
```

This updates the deal name, sets its primary company and clears its primary contact together. Omit a link to keep it, or pass `"properties":{}` to change only relationships. A stale ETag returns 412. An unknown, archived or other-workspace target returns 404 and the entire record edit rolls back. To reconcile a lost reply, read the record’s current ETag and check the association results for `primary: true`. Labeled links are independent.

### Poll for updated records

To pull active records changed during a time window, send a collection request such as `GET /api/v1/records/deals?updatedSince=2026-10-01T00:00:00Z&updatedBefore=2026-10-02T00:00:00Z&limit=50`. Both bounds are required UTC timestamps with up to three fractional digits. The start is inclusive and the end is exclusive. The same query works for all six record types with their existing read permissions.

Select just the fields your integration needs with `&properties=name,amount`. Keep the selection when following a cursor. Ordinary collection and single-record reads accept the same parameter, for example `GET /api/v1/records/contacts?properties=name,email`. Use `custom:<UUID>` for one readable custom field or `custom` for all readable custom values. An empty selection (`properties=`) returns record metadata with an empty properties object. Omit the parameter for the full record. The ETag stays the same across selections and can be used for conditional edits. Archive and deletion feeds accept no field selection.

Records are ordered by update time to the millisecond, then by ID. Keep the same bounds on every page and pass back **both** fields from `next` (`afterUpdatedAt` and `after`). Once `next` is null and the results have been saved, use the last end time as the next start. Upsert by record ID. Overlap recent windows when polling during long-running writes, since a transaction may commit after the reader has passed its update timestamp.

Each result reflects the current record and the token’s current field access. Multiple edits may appear as one result. Related activity, permission changes and permanent deletion can change what an integration sees independently of the record’s update time. Use the archive scan to reconcile the Recycle Bin and subscribe to record-change webhooks when individual changes matter.

### Review integration activity

In **Workspaces → Record access history**, choose an **API operation** to see reads, creates, updates or archives. Filter by token ID or record ID to trace one integration. Each successful write records the token, account, time, object type and affected ID in the same transaction as the record change. A successful update request appears even when the submitted values already matched. Batch writes record each successful item. Older entries appear under **Integration activity** because their operation was not recorded.

### Discover fields before mapping records

Use the record token to request `GET /api/v1/properties/{object}`. The response gives the object name, its readable standard property names in `standardProperties`, and its custom definitions in `customProperties`. Each definition includes its stable ID, current label, type and allowed choices. Contacts, Companies and Deals support custom fields. Tasks, Leads and Tickets return an empty custom list. The discovery request uses the same read permission and rate limit as a record read.

For example, find the **Service level** dropdown in the catalog, select `custom:<its UUID>` in a batch read, then send the chosen value under that UUID in `properties.custom` with the record’s ETag. Save the ID for future updates so a label change keeps your mapping intact. If a custom field becomes restricted, Harbor omits it from discovery and rejects requests that select its ID.

### Find records by email or domain

An integration can use the same batch read endpoint before it knows a Harbor ID. For Contacts set `idProperty` to `email`. For Companies use `domain`. For example, send this body to `POST /api/v1/records/contacts/batch/read` with a contact read token.

```json
{"idProperty":"email","inputs":[{"id":"mira@example.test"}],"properties":["name"]}
```

Harbor matches the entire value, ignoring case, against active records in the token’s workspace. A single match returns the Harbor ID and ETag for a later update. A per-item 404 means no active match. A per-item 409 with code `ambiguous` means several active records match. Resolve the duplicate before updating. Each request accepts the same 1–50 identifiers and 8 KiB maximum as a UUID batch read. Archive lookups require Harbor IDs.

### Match a record by its ID in another system

On Contacts, Companies or Deals, create a single-line text property for the external ID. For example, store the Salesforce Opportunity ID on each imported deal. In the property catalog, find that field's UUID and use it as the `idProperty` on `POST /api/v1/records/deals/batch/read`.

```json
{"idProperty":"custom:11111111-1111-4111-8111-111111111111","inputs":[{"id":"006AB00000abcDe"},{"id":"006AB00000ABCdE"}],"properties":["name","stage"]}
```

Custom IDs match the complete stored text, including case and leading zeroes. Save the returned Harbor ID and ETag to edit a match. A row with no active match returns 404. Multiple active matches return 409; resolve the duplicate before editing. Harbor permits duplicate custom text values. A field that becomes restricted is unavailable for lookup, including when the response requests just the record name. Renaming the field preserves its UUID.

Apply portable migration `0242` during a quiet period on larger installations. It indexes custom values on active contacts, companies and deals.

### Create a batch

Use `POST /api/v1/records/{object}/batch/create` to create up to 50 records of the same type. The key needs read and write access. Generate a UUID for each source record and save that mapping before sending the batch.

```json
{"inputs":[{"id":"cfa19409-403c-4dba-b49b-d4560004dc27","properties":{"name":"Juniper Studio","domain":"juniper.example"}}]}
```

This example targets Companies. Each result includes the input index and ID. A `created` result includes the ETag for a later edit. An existing ID returns a per-record 409 and keeps its existing values. HTTP 200 means all rows succeeded. For HTTP 207 inspect each row. After a lost response, batch-read your original IDs and reconcile the results before retrying. Reuse those IDs on retry.

Each attempted row consumes one write from the same allowance as an individual create. Access loss, throttling or an uncertain write stops the batch and marks later rows `not_attempted`. Honor `Retry-After` if present. The full request must fit in 64 KiB.

### Update a reviewed batch

Read the records and keep each ID and quoted ETag. Send `POST /api/v1/records/{object}/batch/update` with read and write access to that object. Send only the properties you want to change. For example, a quoting system can update deal amounts after a spreadsheet review.

```json
{"inputs":[{"id":"<deal UUID>","etag":"\"<64-character digest from GET>\"","properties":{"amount":1250}}]}
```

A request accepts 1–50 distinct records of one type and up to 64 KiB. Each result includes its input index and ID. An `updated` result includes the current ETag. HTTP 200 means all items succeeded. With HTTP 207, inspect each result. A teammate’s edit returns 412 for that record and other eligible updates can still succeed. Retrieve the changed record and reconcile its values before submitting a new edit.

Each attempted record uses the ordinary write allowance. If Harbor stops because access changed, the rate limit was reached or a write could not be confirmed, later results say `not_attempted`. Honor `Retry-After` when present. After a lost response, batch-read the IDs and compare values before retrying.

### Archive a reviewed batch

For any of the six record types, send `POST /api/v1/records/{object}/batch/archive` with up to 50 distinct IDs and the ETag returned by each active record read. Use the token’s read, write and archive permissions for that object.

```json
{"inputs":[{"id":"<record UUID>","etag":"\"<64-character digest from GET>\""}]}
```

Results follow input order. Each successful item moves to the Recycle Bin independently. HTTP 200 means every item succeeded. HTTP 207 means you should inspect each result. A changed record returns 412 and stays active. A missing or already archived record returns 404. Each attempted item uses the same write allowance as a single DELETE. If access expires, the rate limit is reached or the result becomes uncertain, remaining items are marked `not_attempted`. Honor `Retry-After` when present.

### Reconcile archived records

If an archive request loses its response, use `GET /api/v1/records/{object}/{id}?archived=true` with a key that can track removals or archive that object. A 200 confirms that the record is currently archived in the issuing workspace and returns only `id`, `object` and `archivedAt`. After a restore, the ordinary detail read succeeds again. A permanently deleted or unknown ID returns 404 in both views.

For known IDs, send `POST /api/v1/records/{object}/batch/read?archived=true` with `{"inputs":[{"id":"<record UUID>"}]}` and permission to track removals or archive that object. Omit the properties list. A found row gives the ID, object and archive time. Active, foreign and missing IDs all produce a per-item 404. After an uncertain write, check this result before retrying. If a record is active again, read and review its current version first.

To scan the Recycle Bin, use `GET /api/v1/records/{object}?archived=true&limit=50`. Follow `next.after` as the next request’s `after` parameter until `next` is null. Pages reflect current state, in record-ID order. Use webhooks for the sequence of changes between scans.

To poll recent archives across any of the six record types, send a request such as `GET /api/v1/records/contacts?archived=true&archivedSince=2026-10-01T00:00:00Z&archivedBefore=2026-10-02T00:00:00Z&limit=50`. Use a key that can track removals or archive that object. Both bounds are UTC timestamps with up to three fractional digits. The start is inclusive and the end is exclusive. Results contain the record ID, object type and archive time.

Keep the bounds fixed while paging. Pass back both `next.afterArchivedAt` and `next.after` until `next` is null. After saving the results, start the next window at the previous end. As with active-record polling, overlap recent windows to pick up transactions that commit late.

A restore removes the record from the archive scan and makes it visible in the active update window. If the two scans disagree during a sync, check the record by ID before changing its state downstream. Use the permanent deletion window below to catch an ID removed between polls.

### Catch up on permanent deletions

After applying portable migration `0222`, integrations can poll for deletions even without a webhook subscription. This request checks one day of contact deletions.

```http
GET /api/v1/records/contacts?deletedSince=2026-11-21T00:00:00Z&deletedBefore=2026-11-22T00:00:00Z&limit=50
```

Use the same fixed, inclusive-start and exclusive-end UTC window as the archive scan. Each result contains only `id`, `object` and `deletedAt`. Use both `next.afterDeletedAt` and `next.after` to continue. Save your checkpoint after processing the final page. Overlap recent windows to pick up late commits. The key must be able to track removals or archive that object.

Harbor keeps the latest permanent deletion time for each workspace, object and ID starting with the migration. Archiving and restoring a record leave this feed alone. If an integration recreated an ID, an earlier deletion can still appear. Check current active and archived detail before removing the downstream copy. Use webhooks when you need each separate change event.

On installations with custom database roles, the web reader needs `SELECT` on `portable_record_deletions`. Roles that physically delete CRM records also need `SELECT`, `INSERT` and `UPDATE (deleted_at)` on that table so the deletion and its receipt commit together.

## Receive record changes

A workspace owner can subscribe an HTTPS receiver to changes in any of the six record types under **API access → Outbound webhooks**. New subscriptions begin with the next change. Each message identifies the workspace, subscription, record, object type, revision, event ID, action and time. Actions include creation, update, archive, restore and permanent deletion. To read current property values, the receiving service needs its own scoped read key.

1. Copy the workspace ID from API access. On the web service, set `HARBOR_WEBHOOK_DESTINATIONS` to a JSON array of entries such as `{"workspaceId":"<workspace UUID>","name":"warehouse"}`.
2. On the full background worker, configure the same array with an HTTPS `url` and a private, randomly generated `secret` of at least 32 characters per entry. Set `HARBOR_WEBHOOK_DELIVERY_ENABLED=true` on that worker to enable sends. A Notes-only worker skips webhook delivery.
3. Select the destination and record types in Harbor and click **Subscribe**. Use a new destination name when switching to a different receiver so queued events remain associated with their intended recipient.

To change what goes to an existing destination, open **Subscriptions → Edit record types**, select the types and choose **Save record types**. Harbor keeps the subscription ID and its receipts. Already queued events are still eligible for delivery, including events for types you remove. Adding a type starts capture with new changes. Use the record API to catch up on existing data. If another owner session saved a different selection, refresh deliveries to review the current settings before editing again.

If your self-hosted installation uses restricted PostgreSQL roles, the web service needs `UPDATE (objects)` on `public.portable_webhook_subscriptions` to save a selection. This edit uses the existing table.

The receiver should verify `X-Harbor-Signature` using HMAC-SHA256 over the ASCII `X-Harbor-Timestamp` (Unix seconds), a period and the original request bytes. Compare the `sha256=`-prefixed hex digest in constant time and reject stale timestamps. Store the event ID from `Idempotency-Key` with the receiver’s action in the same transaction. Replays retain that ID, and concurrent deliveries can arrive out of order. Return a 2xx response once the event is durably accepted.

A durable Node receiver can follow this flow. It records each signed event once, refreshes record names and states with a read-only token, and catches up after missed events using bounded API windows.

If the receiver is missing a change, open **API access → Outbound webhooks → Recent deliveries**. Choose **Search deliveries by → Record ID**, select the CRM object type, and enter the record ID. The results show receipts for that record across its subscribed destinations, newest first. Choose **Needs attention** to isolate failures and unknown outcomes. You can also open any event’s **Delivery details → View deliveries for this record**. Refresh and older pages keep the same record filter. Looking up a record sends nothing.

Delivery history shows the last known outcome. Harbor backs off for rate limits. A lost response, timeout, server error or interrupted send can leave the outcome unknown. Search for the exact event ID under **Recent deliveries** and check it at the receiver. If the receiver saved it, choose **Already received** and confirm the receipt. Harbor records the confirming owner and time, keeps the last HTTP result and closes the delivery without sending it again. If the receiver still needs the event, use **Review retry** to queue the same event ID. Successful receipts are eligible for pruning after 30 days. Removing a subscription removes its queued events and receipts. Portable recovery copies omit subscriptions and deliveries so restoring a backup cannot replay the original workspace’s outbound events.

A workflow webhook uses the same signature and delivery headers. Its JSON type is `workflow.action`. The payload identifies the workflow and revision, selected path, source record and revision, contact, job, workspace and time. The event ID is `<workspace UUID>/<job UUID>` and stays the same on retry. Return 2xx after durable acceptance. A 429 permits bounded retries (five attempts total). If the receiver accepts the request and its response is lost, Harbor holds the job for review. Find the event ID in the workflow’s run history.
