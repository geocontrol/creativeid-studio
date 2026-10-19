import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ATPROTO_COLLECTION_NSID,
  createCanonicalPersona,
  fetchFromAtproto,
  fetchFromSolid,
  PersonaStore,
  publishStaticExport,
  publishToAtproto,
  publishToSolid,
} from "../src/index.js";

describe("Milestone 2: Protocol Publishing Adapters (Static, ATProto, Solid)", () => {
  const samplePersona = createCanonicalPersona(
    {
      name: "Daphne Oram",
      biography: "Composer, electronic musician, and creator of the Oramics system.",
    },
    new Date("2026-10-17T15:00:00.000Z")
  );

  it("exports static JSON-LD and Turtle files to disk and records publication", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "cp-static-test-"));
    try {
      const store = new PersonaStore(join(tmpDir, "data", "persona.jsonld"));
      await store.save(samplePersona);

      const jsonLdPath = join(tmpDir, "exports", "creativeid.jsonld");
      const pubTime = new Date("2026-10-17T15:30:00.000Z");
      const result = await publishStaticExport(samplePersona, {
        outputPath: jsonLdPath,
        format: "jsonld",
        publicUrl: "https://oram.example/creativeid.jsonld#me",
        now: pubTime,
      });

      assert.equal(result.contentType, "application/ld+json");
      assert.equal(result.status.uri, "https://oram.example/creativeid.jsonld#me");
      assert.equal(result.status.publishedAt, "2026-10-17T15:30:00.000Z");

      const onDisk = JSON.parse(await readFile(jsonLdPath, "utf8"));
      assert.equal(onDisk["@id"], "https://oram.example/creativeid.jsonld#me");
      assert.equal(onDisk.name, "Daphne Oram");
      assert.equal("creativeid:publications" in onDisk, false);

      // Also verify Turtle static export
      const ttlPath = join(tmpDir, "exports", "creativeid.ttl");
      const ttlResult = await publishStaticExport(samplePersona, {
        outputPath: ttlPath,
        format: "turtle",
        publicUrl: "https://oram.example/creativeid.ttl#me",
        now: pubTime,
      });
      assert.equal(ttlResult.contentType, "text/turtle");
      assert.match(ttlResult.content, /schema:name "Daphne Oram"/);

      const updated = await store.recordPublication("static", result.status);
      assert.equal(
        updated["creativeid:publications"]?.static?.uri,
        "https://oram.example/creativeid.jsonld#me"
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("authenticates, publishes, and fetches a persona record via AT Protocol PDS adapter", async () => {
    const storedRecords = new Map<string, unknown>();
    const calls: Array<{ url: string; method: string; auth?: string }> = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method,
        auth: headers.get("authorization") ?? undefined,
      });

      if (url.endsWith("/xrpc/com.atproto.server.createSession") && method === "POST") {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.identifier, "daphne.bsky.social");
        assert.equal(body.password, "xxxx-yyyy-zzzz-wwww");
        return new Response(
          JSON.stringify({
            did: "did:plc:daphneoram123",
            handle: "daphne.bsky.social",
            accessJwt: "jwt-secret-token",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.endsWith("/xrpc/com.atproto.repo.putRecord") && method === "POST") {
        assert.equal(headers.get("authorization"), "Bearer jwt-secret-token");
        const body = JSON.parse(String(init?.body));
        assert.equal(body.repo, "did:plc:daphneoram123");
        assert.equal(body.collection, ATPROTO_COLLECTION_NSID);
        assert.equal(body.rkey, "self");

        const uri = `at://${body.repo}/${body.collection}/${body.rkey}`;
        const cid = "bafyreidaphneoramcid";
        storedRecords.set(`${body.repo}/${body.collection}/${body.rkey}`, {
          uri,
          cid,
          value: body.record,
        });

        return new Response(JSON.stringify({ uri, cid }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/xrpc/com.atproto.repo.getRecord") && method === "GET") {
        const parsedUrl = new URL(url);
        const key = `${parsedUrl.searchParams.get("repo")}/${parsedUrl.searchParams.get("collection")}/${parsedUrl.searchParams.get("rkey")}`;
        const found = storedRecords.get(key);
        if (!found) {
          return new Response("Not Found", { status: 404 });
        }
        return new Response(JSON.stringify(found), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Unhandled endpoint", { status: 500 });
    };

    const pubTime = new Date("2026-10-17T15:35:00.000Z");
    const pubResult = await publishToAtproto(samplePersona, {
      pdsUrl: "https://bsky.social/",
      identifier: "daphne.bsky.social",
      password: "xxxx-yyyy-zzzz-wwww",
      fetchImpl: mockFetch,
      now: pubTime,
    });

    assert.equal(pubResult.did, "did:plc:daphneoram123");
    assert.equal(
      pubResult.status.uri,
      "at://did:plc:daphneoram123/org.creativepassport.actor.persona/self"
    );
    assert.equal(pubResult.status.cid, "bafyreidaphneoramcid");
    assert.equal(pubResult.record.$type, ATPROTO_COLLECTION_NSID);
    assert.equal(pubResult.record.name, "Daphne Oram");

    const fetched = await fetchFromAtproto(
      "https://bsky.social",
      "did:plc:daphneoram123",
      "self",
      mockFetch
    );
    assert.equal(fetched.value.name, "Daphne Oram");
    assert.equal(
      fetched.value.biography,
      "Composer, electronic musician, and creator of the Oramics system."
    );
    assert.equal(calls.length, 3);
  });

  it("publishes and fetches RDF Turtle and JSON-LD documents via Solid Pod adapter", async () => {
    const podStorage = new Map<string, { contentType: string; content: string }>();

    const mockSolidFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);

      if (method === "PUT") {
        assert.equal(headers.get("authorization"), "Bearer solid-token-123");
        const contentType = headers.get("content-type") ?? "text/plain";
        const content = String(init?.body ?? "");
        podStorage.set(url, { contentType, content });
        return new Response(null, { status: 201 });
      }

      if (method === "GET") {
        const stored = podStorage.get(url);
        if (!stored) {
          return new Response("Not Found", { status: 404 });
        }
        return new Response(stored.content, {
          status: 200,
          headers: { "Content-Type": stored.contentType },
        });
      }

      return new Response("Method Not Allowed", { status: 405 });
    };

    const pubTime = new Date("2026-10-17T15:36:00.000Z");
    const turtleResult = await publishToSolid(samplePersona, {
      resourceUrl: "https://daphne.solidcommunity.net/public/creativeid.ttl",
      format: "turtle",
      authToken: "solid-token-123",
      fetchImpl: mockSolidFetch,
      now: pubTime,
    });

    assert.equal(turtleResult.contentType, "text/turtle");
    assert.equal(
      turtleResult.status.uri,
      "https://daphne.solidcommunity.net/public/creativeid.ttl#me"
    );

    const fetchedTurtle = await fetchFromSolid(
      "https://daphne.solidcommunity.net/public/creativeid.ttl#me",
      mockSolidFetch
    );
    assert.equal(fetchedTurtle.contentType, "text/turtle");
    assert.match(fetchedTurtle.content, /schema:name "Daphne Oram"/);

    // Also test JSON-LD inference from .jsonld extension
    const jsonldResult = await publishToSolid(samplePersona, {
      resourceUrl: "https://daphne.solidcommunity.net/public/creativeid.jsonld",
      authToken: "solid-token-123",
      fetchImpl: mockSolidFetch,
      now: pubTime,
    });
    assert.equal(jsonldResult.contentType, "application/ld+json");
    const parsedJsonLd = JSON.parse(jsonldResult.content);
    assert.equal(
      parsedJsonLd["@id"],
      "https://daphne.solidcommunity.net/public/creativeid.jsonld#me"
    );
  });
});
