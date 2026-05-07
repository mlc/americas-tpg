import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  test,
} from 'node:test';
import { type GadmHandle, openGadm } from './gadm.ts';

const GADM_PATH = process.env.GADM_PATH ?? 'data/gadm.gpkg';
const HAS_GADM = existsSync(GADM_PATH);

describe('openGadm — error paths', () => {
  test('rejects when the configured path does not exist', async () => {
    await assert.rejects(
      openGadm('/tmp/definitely-does-not-exist-gadm.gpkg'),
      /not found/,
    );
  });

  test('rejects a file that is not a geopackage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gadm-bogus-'));
    const bogus = join(dir, 'fake.gpkg');
    try {
      await writeFile(bogus, 'this is not a geopackage');
      await assert.rejects(openGadm(bogus), /Could not open GADM geopackage/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('openGadm.lookup — real GADM 4.10 fixture', {
  skip: !HAS_GADM,
}, () => {
  let gadm: GadmHandle;

  before(async () => {
    gadm = await openGadm();
  });

  after(() => {
    gadm.close();
  });

  test('mid-Atlantic point → ocean', () => {
    assert.deepEqual(gadm.lookup([-40, 0]), { kind: 'ocean' });
  });

  test('mid-Pacific point → ocean', () => {
    assert.deepEqual(gadm.lookup([-90, 0]), { kind: 'ocean' });
  });

  test('Kansas point → mainland-us', () => {
    const result = gadm.lookup([-99, 39]);
    assert.equal(result.kind, 'mainland-us');
    if (result.kind !== 'mainland-us') return;
    assert.equal(result.feature.properties.gid_0, 'USA');
  });

  test('Argentina point → accept with country/level1 populated', () => {
    const result = gadm.lookup([-67.5, -42.5]);
    assert.equal(result.kind, 'accept');
    if (result.kind !== 'accept') return;
    assert.equal(result.feature.properties.gid_0, 'ARG');
    assert.equal(result.feature.properties.name_0, 'Argentina');
    assert.ok(result.feature.properties.name_1.length > 0);
  });

  test('Puerto Rico is accepted as its own country (gid_0=PRI), not mainland-us', () => {
    const result = gadm.lookup([-66.1, 18.4]);
    assert.equal(result.kind, 'accept');
    if (result.kind !== 'accept') return;
    assert.equal(result.feature.properties.gid_0, 'PRI');
  });

  test('U.S. Virgin Islands is accepted as its own country (gid_0=VIR)', () => {
    const result = gadm.lookup([-64.93, 18.34]);
    assert.equal(result.kind, 'accept');
    if (result.kind !== 'accept') return;
    assert.equal(result.feature.properties.gid_0, 'VIR');
  });

  test('returns Polygon or MultiPolygon geometry', () => {
    const result = gadm.lookup([-67.5, -42.5]);
    assert.equal(result.kind, 'accept');
    if (result.kind !== 'accept') return;
    assert.match(result.feature.geometry.type, /^(Polygon|MultiPolygon)$/);
  });
});

describe('openGadm.lookup — caching behaviour', { skip: !HAS_GADM }, () => {
  let gadm: GadmHandle;

  beforeEach(async () => {
    gadm = await openGadm();
  });

  afterEach(() => {
    gadm.close();
  });

  test('repeated lookups at the same point return identical feature objects (cache hit)', () => {
    const a = gadm.lookup([-67.5, -42.5]);
    const b = gadm.lookup([-67.5, -42.5]);
    assert.equal(a.kind, 'accept');
    assert.equal(b.kind, 'accept');
    if (a.kind !== 'accept' || b.kind !== 'accept') return;
    // Cache returns the same parsed object reference.
    assert.equal(a.feature, b.feature);
  });
});
