export interface WebhookPayload {
  action: string;
  sender: { login: string };
  pull_request: {
    number: number;
    title: string;
    body: string;
    head: { ref: string; sha: string };
    base: { ref: string };
    html_url: string;
  };
  repository: {
    full_name: string;
  };
}

export interface JobItem {
  traceId: string;
  routeName: string;
  payload: WebhookPayload;
  createdAt: number;
}
