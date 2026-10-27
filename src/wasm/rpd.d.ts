export type RpdModule = {
  HEAPU8: Uint8Array;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  _rpd_load_scene: (ptr: number, size: number) => number;
};

declare const createRpdModule: (options: {
  canvas: HTMLCanvasElement;
  locateFile: (path: string) => string;
}) => Promise<RpdModule>;

export default createRpdModule;
