import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { Server } from "node:http";

import {
  createStudioServer,
  fetchFromAtproto,
  fetchFromSolid,
  PersonaLibrary,
} from "../src/index.js";

describe("Milestone 3 & 4: Local Web Server, REST API, and End-to-End Publishing", () => {
  let tmpDir: string;
  let server: Server;
  let baseUrl: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cp-server-test-"));
    const library = new PersonaLibrary(join(tmpDir, "data", "personas"));
    const exportDir = join(tmpDir, "data", "exports");

    server = createStudioServer({
      library,
      exportDir,
      legacyV1Path: join(tmpDir, "data", "persona.jsonld"),
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("serves the web UI HTML and static assets", async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /CreativeID/);

    const jsRes = await fetch(`${baseUrl}/app.js`);
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get("content-type") ?? "", /application\/javascript/);
  });

  it("authors, validates, and saves a persona via /api/persona", async () => {
    // Initially null
    const get0 = await fetch(`${baseUrl}/api/persona`);
    const body0 = (await get0.json()) as { persona: unknown };
    assert.equal(body0.persona, null);

    // Rejects invalid input
    const badPut = await fetch(`${baseUrl}/api/persona`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", biography: "" }),
    });
    assert.equal(badPut.status, 400);

    // Saves valid persona
    const goodPut = await fetch(`${baseUrl}/api/persona`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Laurie Spiegel",
        biography: "Composer and pioneer of algorithmic音樂 and Music Mouse.",
        id: "#laurie",
      }),
    });
    assert.equal(goodPut.status, 200);
    const savedData = (await goodPut.json()) as {
      persona: { name: string; "@id": string };
      previews: { atprotoRecord: { name: string }; solidTurtle: string };
    };
    assert.equal(savedData.persona.name, "Laurie Spiegel");
    // v2: the profile is always #me; the public URL decides the published subject.
    assert.equal(savedData.persona["@id"], "#me");
    assert.equal(savedData.previews.atprotoRecord.name, "Laurie Spiegel");
    assert.match(savedData.previews.solidTurtle, /schema:name "Laurie Spiegel"/);
  });

  it("publishes end-to-end to Static Export, ATProto PDS Sandbox, and Solid Pod Sandbox", async () => {
    // 1. Static Export
    const staticRes = await fetch(`${baseUrl}/api/publish/static`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: "jsonld",
        publicUrl: "https://spiegel.example/creativeid.jsonld#laurie",
      }),
    });
    assert.equal(staticRes.status, 200);
    const staticJson = (await staticRes.json()) as {
      result: { status: { uri: string } };
    };
    assert.equal(
      staticJson.result.status.uri,
      "https://spiegel.example/creativeid.jsonld#laurie"
    );

    // Verify file download endpoint
    const dlRes = await fetch(`${baseUrl}/api/export/download?format=turtle`);
    assert.equal(dlRes.status, 200);
    const dlText = await dlRes.text();
    assert.match(dlText, /schema:name "Laurie Spiegel"/);

    // 2. AT Protocol PDS end-to-end publish & readback
    const atprotoRes = await fetch(`${baseUrl}/api/publish/atproto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pdsUrl: `${baseUrl}/sandbox/atproto`,
        identifier: "laurie.creativeid.local",
        password: "app-password-123",
      }),
    });
    assert.equal(atprotoRes.status, 200);
    const atprotoJson = (await atprotoRes.json()) as {
      result: { did: string; status: { uri: string; cid: string } };
    };
    assert.match(
      atprotoJson.result.status.uri,
      /^at:\/\/did:plc:sandboxlauriecreativeidlocal\/org\.creativepassport\.actor\.persona\/self$/
    );

    const verifiedAtproto = await fetchFromAtproto(
      `${baseUrl}/sandbox/atproto`,
      atprotoJson.result.did
    );
    assert.equal(verifiedAtproto.value.name, "Laurie Spiegel");

    // 3. Solid Pod end-to-end publish & readback
    const solidTarget = `${baseUrl}/sandbox/solid/public/creativeid.ttl`;
    const solidRes = await fetch(`${baseUrl}/api/publish/solid`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceUrl: solidTarget,
        format: "turtle",
        authToken: "solid-sandbox-token",
      }),
    });
    assert.equal(solidRes.status, 200);
    const solidJson = (await solidRes.json()) as {
      result: { status: { uri: string } };
      persona: { "creativeid:publications": Record<string, { uri: string }> };
    };
    assert.equal(solidJson.result.status.uri, `${solidTarget}#me`);

    // Verify all 3 publications are recorded on the canonical local persona
    const pubs = solidJson.persona["creativeid:publications"];
    assert.ok(pubs.static);
    assert.ok(pubs.atproto);
    assert.ok(pubs.solid);

    const verifiedSolid = await fetchFromSolid(solidTarget);
    assert.match(verifiedSolid.content, /schema:name "Laurie Spiegel"/);
  });
});
