import type { Member } from './db/database.ts';
import type { Campaign, CampaignEvent } from './domain/campaigns.ts';

export class MailoopClient {
  constructor(private readonly base: string, private readonly token: string) {}

  private async request<T>(path: string, body?: object): Promise<T> {
    const response = await fetch(this.base + '/v1' + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + this.token, ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Request failed (' + response.status + ')');
    return result as T;
  }
  me() { return this.request<Member>('/me'); }
  campaigns() { return this.request<Campaign[]>('/campaigns'); }
  create(name: string) { return this.request<Campaign>('/campaigns', { name }); }
  campaign(id: string) { return this.request<Campaign>('/campaigns/' + encodeURIComponent(id)); }
  approve(id: string, revision: string) { return this.request<Campaign>('/campaigns/' + encodeURIComponent(id) + '/approve', { revision }); }
  events(id: string, after = 0) {
    return this.request<CampaignEvent[]>('/campaigns/' + encodeURIComponent(id) + '/events?after=' + encodeURIComponent(after));
  }
}
