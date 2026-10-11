/** High-level kind of a finding. */
export enum ImageCategory {
  Format = 'FORMAT',
  Structure = 'STRUCTURE',
  Metadata = 'METADATA',
  EmbeddedImage = 'EMBEDDED_IMAGE',
  External = 'EXTERNAL',
  Polyglot = 'POLYGLOT',
  Content = 'CONTENT',
  Limit = 'LIMIT',
  Processing = 'PROCESSING',
}

/** Exact variant of a finding. */
export enum ImageDetail {
  // FORMAT
  Unrecognized = 'UNRECOGNIZED',
  Unsupported = 'UNSUPPORTED',
  Unreadable = 'UNREADABLE',
  // STRUCTURE
  Truncated = 'TRUNCATED',
  BadHeader = 'BAD_HEADER',
  BadChecksum = 'BAD_CHECKSUM',
  BadLayout = 'BAD_LAYOUT',
  BadData = 'BAD_DATA',
  Loop = 'LOOP',
  Overlap = 'OVERLAP',
  Ambiguous = 'AMBIGUOUS',
  TrailingData = 'TRAILING_DATA',
  HiddenData = 'HIDDEN_DATA',
  ExtraBlock = 'EXTRA_BLOCK',
  HeaderCount = 'HEADER_COUNT',
  // METADATA
  Exif = 'EXIF',
  Gps = 'GPS',
  Xmp = 'XMP',
  IccProfile = 'ICC_PROFILE',
  Iptc = 'IPTC',
  Comment = 'COMMENT',
  Text = 'TEXT',
  Thumbnail = 'THUMBNAIL',
  SecondaryImage = 'SECONDARY_IMAGE',
  Other = 'OTHER',
  Stripped = 'STRIPPED',
  Malformed = 'MALFORMED',
  Doctype = 'DOCTYPE',
  // EMBEDDED_IMAGE
  NoPlugin = 'NO_PLUGIN',
  TypeMismatch = 'TYPE_MISMATCH',
  PluginPassed = 'PLUGIN_PASSED',
  PluginScrubbed = 'PLUGIN_SCRUBBED',
  PluginFailed = 'PLUGIN_FAILED',
  PluginRemoved = 'PLUGIN_REMOVED',
  // EXTERNAL
  LinkedProfile = 'LINKED_PROFILE',
  LinkedFile = 'LINKED_FILE',
  // POLYGLOT
  Pdf = 'PDF',
  Zip = 'ZIP',
  ImageData = 'IMAGE_DATA',
  // CONTENT
  OldJpeg = 'OLD_JPEG',
  Escape = 'ESCAPE',
  AbortProc = 'ABORT_PROC',
  // LIMIT
  FileSize = 'FILE_SIZE',
  Pixels = 'PIXELS',
  DecodedSize = 'DECODED_SIZE',
  TotalDecodedSize = 'TOTAL_DECODED_SIZE',
  Frames = 'FRAMES',
  Blocks = 'BLOCKS',
  Scans = 'SCANS',
  MetadataSize = 'METADATA_SIZE',
  NestingDepth = 'NESTING_DEPTH',
  Time = 'TIME',
  // PROCESSING
  VerificationFailed = 'VERIFICATION_FAILED',
}

export type ImageFindingAction = 'reject' | 'strip' | 'info';

/**
 * A finding as any package of the defuse family reports it. Category and detail are plain strings, since the string
 * enums of two packages never match each other.
 */
export interface DefuseFinding {
  category: string;
  detail: string;
  /** Plain sentence, safe to show the uploader. */
  description: string;
  /** Default action after any caller override. */
  action: 'reject' | 'strip' | 'info';
  /** Where in the file, such as a chunk, a segment or an IFD, with its byte offset. */
  location?: string;
  /** Extra values: the block type, the offset, the byte count, the reason. */
  data?: Record<string, string | number>;
  /**
   * Set when the finding comes from inside a contained file: the file's name, with " > " between nesting levels.
   * `location` then starts with where that file sits.
   */
  attachment?: string;
  /** How much the finding adds to a score, set by the package that made it. */
  weight?: number;
}

/** A finding img-defuse makes itself. */
export interface ImageFinding extends DefuseFinding {
  category: ImageCategory;
  detail: ImageDetail;
}

export enum ImageRisk {
  None = 'NONE',
  Low = 'LOW',
  Medium = 'MEDIUM',
  High = 'HIGH',
  Critical = 'CRITICAL',
  /** The file could not be inspected: a refusal, a limit or an unrecognized format stopped the run. */
  Unknown = 'UNKNOWN',
}

export interface ImageInspection {
  status: 'clean' | 'strippable' | 'rejected';
  /** 0 to 100, null when risk is UNKNOWN. */
  score: number | null;
  risk: ImageRisk;
  findings: DefuseFinding[];
  /** The format the content says, as its usual file extension without the dot, such as 'png' or 'jpg'. '' when not recognized. */
  format: string;
  /** The MIME type of a file in that format. '' when not recognized. */
  mimeType: string;
  /** Width of the first image, or of the canvas for GIF and WebP. 0 when not read. */
  width: number;
  /** Height of the first image, or of the canvas for GIF and WebP. 0 when not read. */
  height: number;
  /** Images in the file: 1 for a still image, or the frames, pages and SubIFDs, or icons. 0 when not read. */
  images: number;
}

export interface ImageDisarmResult {
  status: 'clean' | 'defused' | 'rejected';
  /** The uploaded file and its score. */
  before: ImageInspection;
  /** The output and its remaining score. Absent when rejected. */
  after?: ImageInspection;
  /** Findings whose content was removed. */
  removed: DefuseFinding[];
}

/** Random-access input. A buffer, a local file and an S3 ranged GetObject all fit. */
export interface ByteSource {
  size(): Promise<number>;
  read(offset: number, length: number): Promise<Uint8Array>;
  close?(): Promise<void>;
}

/** Append-only output. Never seeks. */
export interface ByteSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  /** Called instead of close() when copying to the sink fails, so a partial output is not taken for a whole one. */
  abort?(error: unknown): Promise<void>;
}

export interface ImageLimits {
  /** Bytes in the upload. Not enforced unless set. */
  fileSize?: number;
  /** Pixels in one image, frame or canvas. Default 268,435,456, which is 16,384 x 16,384. */
  pixels?: number;
  /** Bytes one image or frame decodes to, from its header. Default 1 GiB. */
  decodedBytes?: number;
  /** Bytes all images and frames decode to together. Default 2 GiB. */
  totalDecodedBytes?: number;
  /** Frames, pages, SubIFDs and icons in one file. Default 10,000. */
  frames?: number;
  /** PNG chunks, JPEG segments, GIF blocks, WebP chunks, TIFF entries, strips and tiles, and ICO images. Default 1,000,000. */
  blocks?: number;
  /** SOS markers in one JPEG. Default 1,000. */
  scans?: number;
  /** Bytes one compressed metadata block inflates to. Default 8 MiB. */
  metadataBytes?: number;
  /**
   * The deepest an image may sit in the upload. The upload is at depth 0 and a file inside it at 1, and files of
   * every format in between count. Not enforced unless set.
   */
  nestingDepth?: number;
  /** Milliseconds for the whole run. Not enforced unless set. */
  timeMs?: number;
}

/** What a contained file plugin learns of the run, with nothing format-specific, so any package of the family can make one. */
export interface PluginContext {
  /** The depth of the file itself: 0 for the upload, 1 for a file inside it, and so on, whatever the formats. */
  depth: number;
  /** When a time limit is set, the Date.now() value the whole run must finish by. Nested runs share it. */
  deadline?: number;
}

export interface ContainedFile {
  name?: string;
  /** The MIME type the container declares for the file. */
  declaredType?: string;
  /** From the first bytes. */
  sniffedType?: string;
  /** Decoded size. */
  size: number;
  location: string;
  /** The depth of the file itself: 0 for the upload, 1 for a file inside it, and so on, whatever the formats. */
  depth: number;
  /** Decoded bytes. */
  source: ByteSource;
}

/** What a file plugin did, plus anything it found inside the file. */
export interface ContainedFileResult {
  result: 'scrubbed' | 'passed' | 'removed';
  /** Findings inside the file as it arrived. They go into the report of the file that contains it. */
  findings?: DefuseFinding[];
  /** Findings inside the bytes the plugin kept. They go into the report of the output. */
  outputFindings?: DefuseFinding[];
}

export interface ContainedFilePlugin {
  kind: 'file';
  name: string;
  accepts(file: ContainedFile): boolean | Promise<boolean>;
  /** Writes the bytes to keep. Returning 'removed' drops the file after all. */
  process(file: ContainedFile, sink: ByteSink, context: PluginContext): Promise<'scrubbed' | 'passed' | 'removed' | ContainedFileResult>;
}

export interface ImageActionOverride {
  category: ImageCategory;
  detail?: ImageDetail;
  action: ImageFindingAction;
}

export interface ImageScoreWeight {
  category: ImageCategory;
  detail?: ImageDetail;
  weight: number;
}

/** Lower bound of each band. */
export interface ImageScoreBands {
  low: number;
  medium: number;
  high: number;
  critical: number;
}

export interface ImageOptions {
  limits?: ImageLimits;
  /**
   * Default false. Reports each metadata block the rewrite would remove as METADATA/STRIPPED and makes the status
   * strippable. The ICC profile stays, and so does the orientation.
   */
  stripMetadata?: boolean;
  actionOverrides?: ImageActionOverride[];
  scoreWeights?: ImageScoreWeight[];
  scoreBands?: ImageScoreBands;
  /** Plugins for the images inside the image: thumbnails and the secondary images an MPF index names. */
  filePlugins?: ContainedFilePlugin[];
  /** Directory for temporary files. Defaults to os.tmpdir(). */
  tempDir?: string;
  /**
   * Default 8 MiB. disarmImageSource keeps its copy of the upload, and the output, in memory up to this size and in a
   * temporary file above it. The copies plugins write of the images inside the image share this much memory.
   */
  memoryThreshold?: number;
}
