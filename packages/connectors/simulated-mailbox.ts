import type { Pool } from 'pg';
import { asWorkspace } from '../db/database.ts';

export type Receipt = { receiptId: string; reply: string };

export class SimulatedMailbox {
  constructor(private readonly pool: Pool, private loseNextReceipt = false) {}

  async submit(workspaceId: string, dispatchId: string): Promise<Receipt | null> {
    // The provider commits independently, including when the response is lost.
    const receipt = await asWorkspace(this.pool, workspaceId, async client => {
      await client.query(`
        INSERT INTO simulated_receipts(workspace_id,dispatch_id,reply)
        VALUES ($1,$2,$3) ON CONFLICT (workspace_id,dispatch_id) DO NOTHING`,
        [workspaceId, dispatchId, 'ご連絡ありがとうございます。共同企画について、詳しく教えてください。']);
      const result = await client.query<Receipt>(
        'SELECT receipt_id AS "receiptId", reply FROM simulated_receipts WHERE dispatch_id=$1', [dispatchId]);
      return result.rows[0];
    });
    if (this.loseNextReceipt) {
      this.loseNextReceipt = false;
      return null;
    }
    return receipt;
  }

  lookup(workspaceId: string, dispatchId: string): Promise<Receipt | null> {
    return asWorkspace(this.pool, workspaceId, async client => {
      const result = await client.query<Receipt>(
        'SELECT receipt_id AS "receiptId", reply FROM simulated_receipts WHERE dispatch_id=$1', [dispatchId]);
      return result.rows[0] ?? null;
    });
  }
}
