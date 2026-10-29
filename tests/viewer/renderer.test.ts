/**
 * Namma Space: Spark SceneRenderer Unit Tests
 * Tests WebGL2 requirement, passing verified buffer bytes to SplatMesh (fileBytes),
 * awaiting mesh.initialized, and mapping decode failures to E_SPZ.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { SparkSceneRenderer } from '../../viewer/src/renderer/spark_adapter.js';
import { ViewerError } from '../../viewer/src/types.js';

// Mock @sparkjsdev/spark using Vitest's ESM module mocking
vi.mock('@sparkjsdev/spark', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sparkjsdev/spark')>();

  class MockSparkRenderer extends THREE.Object3D {
    constructor(public options: unknown) {
      super();
    }
    dispose() {}
  }

  class MockSplatMesh extends THREE.Object3D {
    static shouldReject = false;
    static lastOptions: Record<string, unknown> | null = null;

    initialized: Promise<MockSplatMesh>;

    constructor(public options: Record<string, unknown>) {
      super();
      MockSplatMesh.lastOptions = options;
      if (MockSplatMesh.shouldReject) {
        this.initialized = Promise.reject(
          new Error('Corrupted SPZ header or invalid zlib compressed payload')
        );
      } else {
        this.initialized = Promise.resolve(this);
      }
    }

    dispose() {}
  }

  return {
    ...actual,
    SparkRenderer: MockSparkRenderer,
    SplatMesh: MockSplatMesh,
  };
});

function createMockWebGL2Context(): WebGL2RenderingContext {
  const target: Record<string, unknown> = {
    VERSION: 7938,
    SCISSOR_BOX: 3088,
    VIEWPORT: 2978,
    getShaderPrecisionFormat: vi.fn().mockReturnValue({ rangeMin: 127, rangeMax: 127, precision: 23 }),
    getParameter: vi.fn().mockImplementation((p: unknown) => {
      if (p === 3088 || p === 2978) {
        return new Int32Array([0, 0, 800, 600]);
      }
      return 'WebGL 2.0 (OpenGL ES 3.0 Chromium)';
    }),
    getExtension: vi.fn().mockImplementation((_name: string) => ({
      provokingVertexWEBGL: vi.fn(),
    })),
    createBuffer: vi.fn().mockReturnValue({}),
    createTexture: vi.fn().mockReturnValue({}),
    createProgram: vi.fn().mockReturnValue({}),
    createShader: vi.fn().mockReturnValue({}),
    createVertexArray: vi.fn().mockReturnValue({}),
  };

  return new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      if (typeof prop === 'string') {
        t[prop] = vi.fn().mockReturnValue(null);
        return t[prop];
      }
      return undefined;
    },
  }) as unknown as WebGL2RenderingContext;
}

describe('SparkSceneRenderer', () => {
  let mockCanvas: HTMLCanvasElement;
  let mockGl: WebGL2RenderingContext;

  beforeEach(async () => {
    if (typeof globalThis.Worker === 'undefined') {
      (globalThis as Record<string, unknown>).Worker = class MockWorker {
        postMessage = vi.fn();
        terminate = vi.fn();
        addEventListener = vi.fn();
        removeEventListener = vi.fn();
      };
    }

    mockGl = createMockWebGL2Context();

    mockCanvas = {
      getContext: vi.fn().mockImplementation((contextId: string) => {
        if (contextId === 'webgl2') {
          return mockGl;
        }
        return null;
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      clientWidth: 800,
      clientHeight: 600,
      width: 800,
      height: 600,
      style: {},
    } as unknown as HTMLCanvasElement;

    // Reset mock state
    const spark = await import('@sparkjsdev/spark');
    const MockMesh = spark.SplatMesh as unknown as {
      shouldReject: boolean;
      lastOptions: Record<string, unknown> | null;
    };
    MockMesh.shouldReject = false;
    MockMesh.lastOptions = null;
  });

  it('fails with E_WEBGL if canvas cannot provide WebGL 2.0 context', () => {
    const noWebGl2Canvas = {
      getContext: vi.fn().mockReturnValue(null),
    } as unknown as HTMLCanvasElement;

    expect(() => {
      new SparkSceneRenderer({ canvas: noWebGl2Canvas });
    }).toThrowError(ViewerError);

    try {
      new SparkSceneRenderer({ canvas: noWebGl2Canvas });
    } catch (err: unknown) {
      expect((err as ViewerError).code).toBe('E_WEBGL');
      expect((err as ViewerError).message).toContain('WebGL 2.0 is not supported');
    }
  });

  it('catches SplatMesh decode rejection and maps it to E_SPZ', async () => {
    const spark = await import('@sparkjsdev/spark');
    const MockMesh = spark.SplatMesh as unknown as { shouldReject: boolean };
    MockMesh.shouldReject = true; // Trigger rejection in mesh.initialized

    const renderer = new SparkSceneRenderer({ canvas: mockCanvas });
    const dummyBuffer = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0, 1, 2, 3]).buffer;

    try {
      await expect(
        renderer.load(
          {
            uri: 'corrupt.spz',
            sha256: '0000000000000000000000000000000000000000000000000000000000000000',
            buffer: dummyBuffer,
          },
          vi.fn()
        )
      ).rejects.toThrowError(ViewerError);

      try {
        await renderer.load(
          {
            uri: 'corrupt.spz',
            sha256: '0000000000000000000000000000000000000000000000000000000000000000',
            buffer: dummyBuffer,
          },
          vi.fn()
        );
      } catch (err: unknown) {
        expect((err as ViewerError).code).toBe('E_SPZ');
        expect((err as ViewerError).message).toContain('Failed to decode Gaussian splat data');
        expect((err as ViewerError).message).toContain('Corrupted SPZ');
      }
    } finally {
      renderer.dispose();
    }
  });

  it('passes verified fileBytes buffer directly to SplatMesh options without second download', async () => {
    const spark = await import('@sparkjsdev/spark');
    const MockMesh = spark.SplatMesh as unknown as {
      shouldReject: boolean;
      lastOptions: Record<string, unknown> | null;
    };
    MockMesh.shouldReject = false;

    const renderer = new SparkSceneRenderer({ canvas: mockCanvas });
    const dummyBuffer = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 42, 43, 44]).buffer;

    try {
      await renderer.load(
        {
          uri: 'valid.spz',
          sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
          buffer: dummyBuffer,
        },
        vi.fn()
      );

      expect(MockMesh.lastOptions).not.toBeNull();
      // Verifies that fileBytes was passed directly, avoiding a second network fetch!
      expect(MockMesh.lastOptions?.fileBytes).toBe(dummyBuffer);
      expect(MockMesh.lastOptions?.fileName).toBe('valid.spz');
    } finally {
      renderer.dispose();
    }
  });
});
