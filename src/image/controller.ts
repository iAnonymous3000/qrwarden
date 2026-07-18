import {
  DecoderFailure,
  DecoderWorkerClient,
  type DecoderFailureCode,
  type DecoderOutcome,
} from "../decoder";

const MAX_FILE_BYTES = 25_000_000;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

export type ImageIntakeProblem =
  | DecoderFailureCode
  | "choose-one-image"
  | "image-too-large"
  | "unsupported-image-type";

export interface ImageScanResult {
  readonly outcome: DecoderOutcome;
  readonly generation: number;
}

export interface ImageControllerOptions {
  readonly workerFactory: () => Worker;
  readonly onResult: (result: ImageScanResult) => void;
  readonly onProblem: (problem: ImageIntakeProblem) => void;
}

function validateFile(file: File): ImageIntakeProblem | null {
  if (file.size > MAX_FILE_BYTES) {
    return "image-too-large";
  }
  if (file.type !== "" && !ALLOWED_MIME.has(file.type)) {
    return "unsupported-image-type";
  }
  return null;
}

export function filesFromDrop(dataTransfer: DataTransfer): readonly File[] {
  const files: File[] = [];
  for (const item of dataTransfer.items) {
    if (item.kind !== "file") {
      continue;
    }
    const file = item.getAsFile();
    if (file !== null) {
      files.push(file);
    }
  }
  if (dataTransfer.items.length === 0) {
    files.push(...Array.from(dataTransfer.files));
  }
  return Object.freeze(files);
}

export function installDropNavigationGuard(
  onFiles: ((files: readonly File[]) => void) | null,
): () => void {
  const onDragOver = (event: DragEvent): void => {
    event.preventDefault();
  };
  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    if (event.dataTransfer !== null && onFiles !== null) {
      onFiles(filesFromDrop(event.dataTransfer));
    }
  };
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("drop", onDrop);
  return () => {
    window.removeEventListener("dragover", onDragOver);
    window.removeEventListener("drop", onDrop);
  };
}

export class ImageController {
  readonly #workerFactory: () => Worker;
  readonly #onResult: ImageControllerOptions["onResult"];
  readonly #onProblem: ImageControllerOptions["onProblem"];
  #generation = 0;
  #client: DecoderWorkerClient | null = null;

  constructor(options: ImageControllerOptions) {
    this.#workerFactory = options.workerFactory;
    this.#onResult = options.onResult;
    this.#onProblem = options.onProblem;
  }

  get busy(): boolean {
    return this.#client !== null;
  }

  choose(files: readonly File[]): void {
    if (files.length !== 1) {
      this.#onProblem("choose-one-image");
      return;
    }
    const file = files[0];
    if (file === undefined) {
      this.#onProblem("choose-one-image");
      return;
    }
    const problem = validateFile(file);
    if (problem !== null) {
      this.#onProblem(problem);
      return;
    }
    void this.#decode(file);
  }

  cancel(): void {
    this.#generation += 1;
    this.#client?.dispose("cancelled");
    this.#client = null;
  }

  async #decode(file: File): Promise<void> {
    this.cancel();
    const generation = this.#generation;
    let client: DecoderWorkerClient | null = null;
    let result: ImageScanResult | null = null;
    try {
      client = new DecoderWorkerClient(this.#workerFactory);
      this.#client = client;
      await client.start();
      if (this.#client !== client || generation !== this.#generation) {
        return;
      }
      const outcome = await client.decodeImage(file, generation);
      if (this.#client !== client || generation !== this.#generation) {
        if (outcome.kind === "multiple") {
          outcome.preview.bitmap.close();
        }
        return;
      }
      result = { outcome, generation };
    } catch (error) {
      if (
        generation === this.#generation &&
        (client === null || this.#client === client)
      ) {
        const code = error instanceof DecoderFailure ? error.code : "reader-stopped";
        if (code !== "cancelled") {
          this.#onProblem(code);
        }
      }
    } finally {
      if (client !== null && this.#client === client) {
        client.dispose("cancelled");
        this.#client = null;
      }
    }
    if (result !== null) {
      this.#onResult(result);
    }
  }
}
