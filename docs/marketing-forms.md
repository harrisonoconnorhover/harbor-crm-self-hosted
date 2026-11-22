# Route website inquiries to your team and Salesforce

Use a separate Harbor form for each destination, such as a Webflow sales page and a WordPress support page. Each form can notify up to eight configured internal addresses, create a Salesforce submission record, or do both. The visitor supplies a name, email, optional phone and message. These fields never select the notification recipients. Submitting a form does not grant marketing email consent.

## Put the form on your website

In the portable app, the form's workspace owner opens **Forms**, saves a form, enters the exact website origin under **Website origin for embedding**, and enables it. Open **Embed on your website** and copy the iframe. Use a separate form for a second website origin. Leave **Contact capture** off when you want inquiries in Harbor and Salesforce to remain your sales CRM.

Paste the iframe in a **Code Embed** element on Webflow or a **Custom HTML** block on WordPress. The site must permit iframe embeds and the publisher must have permission to save the markup. Publish the page and submit one fictional inquiry from the actual website. If a host strips the iframe, use the form's direct URL. Harbor accepts 30 inquiries per form per rolling hour and 100 per workspace per UTC day. Estimate expected website traffic separately from the size of the marketing list. [Webflow embed instructions](https://help.webflow.com/hc/en-us/articles/33961332238611-Custom-code-embed) · [WordPress Custom HTML block](https://wordpress.org/documentation/article/custom-html/).

## Connect the destinations

Set `HARBOR_MARKETING_WORKSPACE_ID` to the same workspace UUID on the web app (to queue new submissions) and on the operator process (to configure and dispatch them). Set `HARBOR_MARKETING_FORM_RECIPIENTS` on the operator to a comma-separated list of approved internal addresses. Configure the email provider and verified sending address for notifications. A form's UUID is the last part of its public URL.

For Salesforce, configure the same My Domain and server-side OAuth connection used for audience sync. Grant the integration user access to create, read and update your chosen inquiry object and the mapped fields. Create a unique Text External ID field with room for 73 characters. Harbor uses the workspace and inquiry UUIDs together, so reprocessing the same submission addresses the same Salesforce record. Salesforce rules and flows on that object can also run when the integration writes. [Salesforce external-ID API](https://developer.salesforce.com/docs/platform/api-rest/guide/resources-sobject-upsert.html).

Set `HARBOR_SALESFORCE_FORM_MAPPING` to JSON matching fields that actually exist in your org. For example, the following maps onto a fictional custom object. The optional `constants` object sets up to twelve fixed string values, including required fields or source labels. The owner chooses recipients per form. The Salesforce mapping belongs to the installation.

```json
{
  "object": "Website_Inquiry__c",
  "externalIdField": "Harbor_Key__c",
  "fields": {
    "name": "Name",
    "email": "Email__c",
    "phone": "Phone__c",
    "message": "Message__c"
  },
  "constants": { "Source__c": "Website" }
}
```

For forms that collect country or region, add `"country": "Country__c"` to `fields` to send the submitted answer to that Salesforce field. Use your actual field name. Harbor omits blank answers. After changing the mapping, confirm the updated destination on the form before dispatch.

The workspace owner can set these destinations in **Marketing → Email marketing → Website forms**. To configure them from the operator shell, use the form ID.

```sh
node scripts/portable-web.mjs marketing form-config "$SALES_FORM_ID" '{"recipients":["sales@example.test"],"salesforce":true}'
node scripts/portable-web.mjs marketing form-config "$SUPPORT_FORM_ID" '{"recipients":["support@example.test"],"salesforce":false}'
```

Routing begins with the next accepted submission. Running the same configuration twice preserves the existing queue. Changing it skips queued actions from the previous configuration. A delivery already in flight can still complete. To pause a form's routing, configure it with `{"recipients":[],"salesforce":false}`.

## Process submissions and check receipts

Set `HARBOR_MARKETING_DELIVERY_ENABLED=true` only in an operator environment intended to contact these providers. Run a bounded pass yourself or from your own scheduler. The ordinary Notes worker does not send form notifications. Each submission has a separate receipt for each intended recipient and for Salesforce.

```sh
node scripts/portable-web.mjs marketing forms-run 20
node scripts/portable-web.mjs marketing forms-status
```

If campaigns also run at this time, assign the form pass its own share of the provider budget. For example, use `forms-run 20 --rate-slots 5-5` alongside a campaign using slots `1-4`. The two workers can then run simultaneously. [Worker configuration](marketing.md#run-a-campaign-across-worker-replicas)

A provider rate limit schedules a later attempt with increasing delays. The worker holds an uncertain result for investigation if it loses the provider's acknowledgment or stops during dispatch. Check your email provider by the idempotency key `harbor-form-DELIVERY_ID`, or look up Salesforce by the external ID `WORKSPACE_UUID-INQUIRY_UUID`. Repeated Salesforce attempts check for the existing record before writing. Verify the provider result before resolving one receipt.

```sh
node scripts/portable-web.mjs marketing form-resolve "$DELIVERY_ID" confirmed "$PROVIDER_RECEIPT"
node scripts/portable-web.mjs marketing form-resolve "$DELIVERY_ID" retry "$VERIFIED_NON_ACCEPTANCE_REFERENCE"
node scripts/portable-web.mjs marketing form-resolve "$DELIVERY_ID" skip "$INVESTIGATION_REFERENCE"
```

Use one decision per receipt. The processing account needs the same workspace binding and current route to dispatch a retry. Removed inquiries are skipped. Route authorizations must be set up afresh on a restored instance. Reconfiguring the same recipients on a restore cannot release old queued submissions.

Local coverage uses real PostgreSQL, fictional submissions and simulated Salesforce and mail responses. Production qualification requires a published test page on each CMS, a Salesforce sandbox record and receipt, and a notification received at a designated internal mailbox.
