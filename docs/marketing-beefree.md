# Design marketing email in Beefree

Beefree is an optional visual email designer in portable Harbor. It lets a team keep editing its Beefree templates inside Harbor. Harbor stores the subject, optional plain-text version, editable project and rendered HTML in PostgreSQL. For a newsletter or announcement using Harbor's built-in designer, start at **Email designs → New design**. [Built-in email designer](marketing.md#set-up-a-rehearsal)

## Configure the editor

1. In the Beefree SDK Developer Console, use an **Email Builder** application for this Harbor installation. Get its client ID and client secret. The SDK is licensed separately. Beefree counts editor workspace identifiers in its licensing model. [Create an SDK application](https://docs.beefree.io/beefree-sdk/getting-started/readme/create-an-application) · [How Beefree counts UIDs](https://docs.beefree.io/beefree-sdk/getting-started/readme/installation/how-the-uid-parameter-works)
2. Set `HARBOR_MARKETING_WORKSPACE_ID` to the Harbor workspace UUID. Put `HARBOR_BEEFREE_CLIENT_ID` and `HARBOR_BEEFREE_CLIENT_SECRET` in the **web service's** private environment. Restart the web service after changing these settings.
3. Sign in as the owner of that workspace. Open **Marketing → Email marketing → Email designs → Use Beefree**. Supply the subject recipients should see, then select **Open Beefree editor**. Make a small layout change and choose **Save design**. Close the editor and select **Preview saved email**. Reopen the design to verify you can edit its original layout.

The web server exchanges the credentials and a stable workspace identifier for a temporary editor token. The browser loads the official Beefree SDK when the owner opens the editor and supplies the saved design to it. The request carries the workspace UUID prefixed with `harbor-`. Recipient addresses and Salesforce audience data stay outside this exchange. Follow your organization's rules for any content or images you put in the designer. [SDK authorization](https://docs.beefree.io/beefree-sdk/getting-started/readme/installation/authorization-process-in-detail) · [Official browser loader](https://github.com/BeefreeSDK/beefree-sdk-npm-official/blob/master/src/utils/Constants.ts)

## Bring existing designs

In **Email designs**, choose **Import Beefree design**, or **Use Beefree** if the editor is connected. Enter a name and subject, expand **Import an existing Beefree email**, then choose the editable JSON and rendered HTML from the same email export (up to 1 MiB per file). Save and preview it before choosing it for a campaign. A paired export can be imported and previewed with the SDK unconfigured. Editing its layout inside Harbor uses the configured SDK application.

## Trial check

Use a fictional email. A successful save shows **Design saved**. Open the same design in two tabs, save a subject change in one, then verify a conflicting save in the other asks you to reopen it. Opening the saved preview uses a sandboxed frame. HTTPS images embedded in the design can load from their hosts. The hosted editor and licensed account still need a real trial. The local automated tests simulate Beefree and exercise Harbor's persistence and ownership behavior.
