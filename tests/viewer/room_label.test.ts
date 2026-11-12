import { describe, it, expect } from 'vitest';
import { roomLabel } from '../../viewer/src/ui/app_ui';

describe('roomLabel', () => {
  it('names known scenes by id', () => {
    expect(roomLabel('scn_hostelroomac').name).toBe('K-720');
  });
  it('names a full manifest URL by its scene folder', () => {
    expect(roomLabel('https://adarcside.github.io/namma-space/round2/scn_hostelroomac/manifest.json')).toEqual({ name: 'K-720', kind: 'Hostel room' });
    expect(roomLabel('/scenes/scn_lab/manifest.json?v=2').name).toBe('lab');
  });
  it('keeps the dev and unknown fallbacks', () => {
    expect(roomLabel('dev').name).toBe('Dev room');
    expect(roomLabel('scn_cafe')).toEqual({ name: 'cafe', kind: 'Scene' });
  });
});
