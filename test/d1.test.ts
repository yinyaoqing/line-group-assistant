import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultGroup } from "../config/defaults";
import { D1AdminRepo } from "../src/storage/admins";
import { D1ChannelRepo } from "../src/storage/channels";
import { D1Storage } from "../src/storage/d1";
import { D1GroupRepo, D1UsageMeter, monthKey } from "../src/storage/groups";
import init from "../migrations/0001_init.sql?raw";
import v2 from "../migrations/0002_admins_channels_plans.sql?raw";

// Runs the real SQL against a local, in-memory D1 (workerd via wrangler).
let proxy: PlatformProxy<{ DB: D1Database }>;
let db: D1Database;

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({ persist: false });
  db = proxy.env.DB;
  const sql = [init, v2].join(";\n").replace(/--.*$/gm, "");
  const statements = sql.split(";").map((s: string) => s.trim()).filter(Boolean);
  await db.batch(statements.map((s: string) => db.prepare(s)));
}, 60_000);

afterAll(() => proxy?.dispose());

describe("D1Storage", () => {
  it("numbers rows per group and table, updates and lists them", async () => {
    const a = new D1Storage(db, "Ca");
    const b = new D1Storage(db, "Cb");
    const [r1, r2] = await Promise.all([a.append("tasks", { title: "一" }), a.append("tasks", { title: "二" })]);
    expect([r1.id, r2.id].sort()).toEqual(["1", "2"]);
    expect((await b.append("tasks", { title: "別組" })).id).toBe("1");
    expect((await a.append("translate", { enabled: "false" })).id).toBe("1");

    expect(await a.update("tasks", "1", { status: "完成" })).toMatchObject({ id: "1", status: "完成" });
    expect(await a.update("tasks", "99", { status: "完成" })).toBeUndefined();
    expect(await a.update("tasks", "x", { status: "完成" })).toBeUndefined();
    expect((await a.list("tasks")).map((r) => r.id)).toEqual(["1", "2"]);
    expect(await b.list("tasks")).toEqual([{ id: "1", title: "別組" }]);
  });
});

describe("D1GroupRepo", () => {
  it("registers once as pending, activates and lists active groups", async () => {
    const repo = new D1GroupRepo(db);
    await repo.register({ ...defaultGroup("Cg"), name: "工班" });
    await repo.update("Cg", { settings: { translate: { languages: ["zh-TW", "vi"] } } });
    await repo.register({ ...defaultGroup("Cg"), name: "工班（新名稱）" });
    // Re-registering refreshes the LINE group name but keeps the group's settings.
    expect(await repo.get("Cg")).toMatchObject({
      status: "pending",
      name: "工班（新名稱）",
      channelId: "default",
      plan: "free",
      plugins: ["translate", "tasks", "items"],
      storage: { type: "d1" },
      settings: { translate: { languages: ["zh-TW", "vi"] } },
    });
    expect(await repo.listActive()).toEqual([]);
    expect((await repo.activate("Cg"))?.status).toBe("active");
    expect((await repo.listActive()).map((g) => g.groupId)).toEqual(["Cg"]);

    // Removed, then invited again: back to pending, so it needs activating again.
    await repo.update("Cg", { status: "left" });
    await repo.register(defaultGroup("Cg"));
    expect(await repo.get("Cg")).toMatchObject({ status: "pending", name: "工班（新名稱）" });

    await repo.update("Cg", { plan: "pro", planUntil: "2026-12-31" });
    expect(await repo.get("Cg")).toMatchObject({ plan: "pro", planUntil: "2026-12-31" });
    expect((await repo.listAll()).map((g) => g.groupId)).toContain("Cg");
    expect(await repo.get("Cmissing")).toBeUndefined();
  });
});

describe("D1UsageMeter", () => {
  it("adds up per group and Taipei month", async () => {
    const meter = new D1UsageMeter(db);
    const oct31Taipei = new Date("2026-10-31T17:00:00Z"); // Nov 1, 01:00 in Taipei
    await meter.add("Cu", "translate_chars", 10, oct31Taipei);
    await meter.add("Cu", "translate_chars", 5, oct31Taipei);
    expect(monthKey(oct31Taipei)).toBe("2026-11");
    expect(await meter.get("Cu", "translate_chars", oct31Taipei)).toBe(15);
    expect(await meter.get("Cu", "translate_chars", new Date("2026-10-15T00:00:00Z"))).toBe(0);
  });
});

describe("D1AdminRepo", () => {
  it("adds admins, binds a login once and consumes nonces once", async () => {
    const repo = new D1AdminRepo(db);
    await repo.add("Ca1", "U-owner", "owner");
    await repo.add("Ca1", "U-owner", "admin"); // no-op: keeps the owner role
    await repo.add("Ca1", "U-helper", "admin");
    expect((await repo.list("Ca1")).map((a) => [a.lineUserId, a.role])).toEqual([
      ["U-owner", "owner"],
      ["U-helper", "admin"],
    ]);

    expect(await repo.bindLogin("Ca1", "U-owner", "login-1")).toBe("ok");
    expect(await repo.bindLogin("Ca1", "U-owner", "login-1")).toBe("ok");
    expect(await repo.bindLogin("Ca1", "U-owner", "login-2")).toBe("conflict");
    expect(await repo.bindLogin("Ca1", "U-nobody", "login-1")).toBe("missing");
    expect((await repo.groupsForLogin("login-1")).map((a) => a.groupId)).toEqual(["Ca1"]);

    await repo.remove("Ca1", "U-helper");
    expect(await repo.get("Ca1", "U-helper")).toBeUndefined();

    expect(await repo.consumeNonce("n1")).toBe(true);
    expect(await repo.consumeNonce("n1")).toBe(false);
  });
});

describe("D1ChannelRepo", () => {
  it("stores, updates and removes channels", async () => {
    const repo = new D1ChannelRepo(db);
    await repo.put({ channelId: "acme", name: "Acme", secretEnc: "s1", tokenEnc: "t1", joinPolicy: "open" });
    await repo.put({ channelId: "acme", name: "Acme 2", secretEnc: "s2", tokenEnc: "t2", joinPolicy: "code", activationCode: "c" });
    expect(await repo.get("acme")).toEqual({ channelId: "acme", name: "Acme 2", secretEnc: "s2", tokenEnc: "t2", joinPolicy: "code", activationCode: "c" });
    expect((await repo.list()).map((c) => c.channelId)).toEqual(["acme"]);
    await repo.remove("acme");
    expect(await repo.get("acme")).toBeUndefined();
  });
});
