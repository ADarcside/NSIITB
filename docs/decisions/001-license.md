# 001 · Picking a licence

## Status
Accepted

## Date
2026-10-17

## Context
Per Section 6 (Phase 0) and Section 19.1 of the Namma Space specification, the project must establish a clear license before the first public commit. The license choices evaluated are MIT and Apache-2.0.

## Decision
We select the **MIT License** for Namma Space.

## Rationale
1. **Compatibility**: The browser viewer components (Three.js, Spark, Vite, splat-transform) and core spatial libraries (Open3D) are licensed under MIT.
2. **Simplicity and Permissiveness**: MIT offers maximum permissiveness and clean integration with downstream tools and dependencies without patent-grant overheads that complicate educational and hackathon project delivery.
3. **Compliance**: Avoids any restrictive licenses (AGPL, GPL, or non-commercial licenses). All third-party components and their respective licenses are tracked in `THIRD_PARTY_NOTICES.md`.
