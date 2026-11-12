declare module "adm-zip" {
  export interface AdmZipEntry {
    readonly entryName: string;
    readonly isDirectory: boolean;
    readonly header: {
      readonly size: number;
      readonly attr?: number;
      readonly flags?: number;
    };
    getData(): Buffer;
  }

  export default class AdmZip {
    constructor(fileName?: string);
    getEntries(): AdmZipEntry[];
    getEntry(name: string): AdmZipEntry | null;
    addFile(entryName: string, content: Buffer): void;
    writeZip(targetFileName?: string): void;
  }
}
