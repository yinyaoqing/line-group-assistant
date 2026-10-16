/** A white-label LINE official account, served at /webhook/<channelId>. */
export interface Channel {
  channelId: string;
  name: string;
  /** Channel secret and access token, AES-GCM encrypted (see core/crypto.ts). */
  secretEnc: string;
  tokenEnc: string;
  /** "open": invited groups activate at once; "code": they need a one-time code (see codes.ts). */
  joinPolicy: "open" | "code";
}

export interface ChannelRepo {
  get(channelId: string): Promise<Channel | undefined>;
  list(): Promise<Channel[]>;
  put(channel: Channel): Promise<void>;
  remove(channelId: string): Promise<void>;
}

interface ChannelRecord {
  channel_id: string;
  name: string;
  secret_enc: string;
  token_enc: string;
  join_policy: string;
  activation_code: string | null;
}

const fromRecord = (r: ChannelRecord): Channel => ({
  channelId: r.channel_id,
  name: r.name,
  secretEnc: r.secret_enc,
  tokenEnc: r.token_enc,
  joinPolicy: r.join_policy === "code" ? "code" : "open",
});

export class D1ChannelRepo implements ChannelRepo {
  constructor(private db: D1Database) {}

  async get(channelId: string) {
    const r = await this.db.prepare("SELECT * FROM channels WHERE channel_id = ?").bind(channelId).first<ChannelRecord>();
    return r ? fromRecord(r) : undefined;
  }

  async list() {
    const { results } = await this.db.prepare("SELECT * FROM channels ORDER BY created_at").all<ChannelRecord>();
    return results.map(fromRecord);
  }

  async put(c: Channel) {
    await this.db
      .prepare(
        `INSERT INTO channels (channel_id, name, secret_enc, token_enc, join_policy, activation_code) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (channel_id) DO UPDATE SET name = excluded.name, secret_enc = excluded.secret_enc,
           token_enc = excluded.token_enc, join_policy = excluded.join_policy, activation_code = excluded.activation_code`,
      )
      .bind(c.channelId, c.name, c.secretEnc, c.tokenEnc, c.joinPolicy, null)
      .run();
  }

  async remove(channelId: string) {
    await this.db.prepare("DELETE FROM channels WHERE channel_id = ?").bind(channelId).run();
  }
}

export class MemoryChannelRepo implements ChannelRepo {
  channels: Channel[] = [];

  async get(channelId: string) {
    return this.channels.find((c) => c.channelId === channelId);
  }

  async list() {
    return [...this.channels];
  }

  async put(c: Channel) {
    await this.remove(c.channelId);
    this.channels.push(c);
  }

  async remove(channelId: string) {
    this.channels = this.channels.filter((c) => c.channelId !== channelId);
  }
}
