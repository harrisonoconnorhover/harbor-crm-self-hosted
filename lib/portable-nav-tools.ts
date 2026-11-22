export const portableToolNames={
  contacts:'Contacts',companies:'Companies',deals:'Deals',tickets:'Tickets',tasks:'Tasks',segments:'Lists',
  'team-inbox':'Inbox',products:'Products',quotes:'Quotes','custom-objects':'Custom objects',templates:'Email templates',
  calls:'Calls',snippets:'Snippets',leads:'Leads',marketing:'Email marketing',campaigns:'Campaigns',forms:'Forms','landing-pages':'Landing pages',
  files:'Files','sales-workspace':'Sales workspace',forecast:'Forecast',goals:'Goals',sequences:'Sequences',meetings:'Meetings',invoices:'Invoices',payments:'Payments',subscriptions:'Subscriptions',
  'help-desk':'Help desk',knowledge:'Knowledge base','customer-portal':'Customer portal',integrations:'Integrations','data-management':'Data management settings',duplicates:'Duplicates',import:'CSV import',workflows:'Workflows',dashboards:'Dashboards',
  reports:'Reports','web-attribution':'Marketing analytics',calendar:'Calendar','recycle-bin':'Recycle Bin',
} as const;
export type PortableTool=keyof typeof portableToolNames;
export const maxPortableBookmarks=5;
export const isPortableTool=(value:unknown):value is PortableTool=>typeof value==='string'&&Object.hasOwn(portableToolNames,value);
