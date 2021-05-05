const fs = require("fs");
const { inflateSync } = require("zlib");
const { PNG } = require("pngjs");

// Constants lifted from
// https://github.com/aseprite/aseprite/blob/main/src/dio/aseprite_common.h.

const ASE_FILE_MAGIC = 0xa5e0;
const ASE_FILE_FRAME_MAGIC = 0xf1fa;

const ASE_FILE_FLAG_LAYER_WITH_OPACITY = 1;

const ASE_FILE_CHUNK_FLI_COLOR2 = 4;
const ASE_FILE_CHUNK_FLI_COLOR = 11;
const ASE_FILE_CHUNK_LAYER = 0x2004;
const ASE_FILE_CHUNK_CEL = 0x2005;
const ASE_FILE_CHUNK_CEL_EXTRA = 0x2006;
const ASE_FILE_CHUNK_COLOR_PROFILE = 0x2007;
const ASE_FILE_CHUNK_MASK = 0x2016;
const ASE_FILE_CHUNK_PATH = 0x2017;
const ASE_FILE_CHUNK_TAGS = 0x2018;
const ASE_FILE_CHUNK_PALETTE = 0x2019;
const ASE_FILE_CHUNK_USER_DATA = 0x2020;
const ASE_FILE_CHUNK_SLICES = 0x2021; // Deprecated chunk (used on dev versions only between v1.2-beta7 and v1.2-beta8)
const ASE_FILE_CHUNK_SLICE = 0x2022;
const ASE_FILE_CHUNK_TILESET = 0x2023;

const ASE_FILE_LAYER_IMAGE = 0;
const ASE_FILE_LAYER_GROUP = 1;

const ASE_FILE_RAW_CEL = 0;
const ASE_FILE_LINK_CEL = 1;
const ASE_FILE_COMPRESSED_CEL = 2;

const ASE_FILE_NO_COLOR_PROFILE = 0;
const ASE_FILE_SRGB_COLOR_PROFILE = 1;
const ASE_FILE_ICC_COLOR_PROFILE = 2;

const ASE_COLOR_PROFILE_FLAG_GAMMA = 1;

const ASE_PALETTE_FLAG_HAS_NAME = 1;

const ASE_USER_DATA_FLAG_HAS_TEXT = 1;
const ASE_USER_DATA_FLAG_HAS_COLOR = 2;

const ASE_CEL_EXTRA_FLAG_PRECISE_BOUNDS = 1;

const ASE_SLICE_FLAG_HAS_CENTER_BOUNDS = 1;
const ASE_SLICE_FLAG_HAS_PIVOT_POINT = 2;

const COLORMODE_RGB = 1;
const COLORMODE_GRAYSCALE = 2;
const COLORMODE_INDEXED = 3;

// https://github.com/aseprite/aseprite/blob/f1b02a3347f51bfd74e1e55bdf2e7211471c59f8/src/doc/layer.h#L33

const LAYER_NONE = 0;
const LAYER_VISIBLE = 1; // Can be read
const LAYER_EDITABLE = 2; // Can be written
const LAYER_LOCKMOVE = 4; // Cannot be moved
const LAYER_BACKGROUND = 8; // Stack order cannot be changed
const LAYER_CONTINUOUS = 16; // Prefer to link cels when the user copy them
const LAYER_COLLAPSED = 32; // Prefer to show this group layer collapsed
const LAYER_REFERENCE = 64; // Is a reference layer

const headerPos = 0;

function fileParser(file) {
  let i = 0;
  let parsed = {};
  let self = {
    nextUint(width) {
      let bytes = width / 8;

      let result = 0;
      for (let j = 0; j < bytes; j++) {
        result += file[i + j] * Math.pow(2, j * 8);
      }
      i += bytes;
      return result;
    },
    uint(name, width) {
      parsed[name] = self.nextUint(width);
      return self;
    },
    int(name, width) {
      let val = self.nextUint(width);
      if (val & (1 << (width - 1))) {
        val -= 2 * Math.pow(2, width - 1);
      }
      parsed[name] = val;
      return self;
    },

    nextString() {
      let length = self.nextUint(16);

      let result = file.slice(i, i + length).toString();
      i += length;
      return result;
    },
    string(name) {
      parsed[name] = self.nextString();
      return self;
    },
    flush() {
      let old = parsed;
      parsed = {};
      return old;
    },
    seek(pos) {
      i = pos;
      return self;
    },
    jump(d) {
      i += d;
      return self;
    },
    tell() {
      return i;
    },
    sub(start, end) {
      return file.slice(start, end);
    },
  };

  return self;
}

const HEADER = "HEADER";
const FRAME = "FRAME";
const CEL = "CEL";
const LAYER = "LAYER";

function* parse(fname) {
  let parser = fileParser(fs.readFileSync(fname));
  let header = parser
    .seek(headerPos)
    .uint("size", 32)
    .uint("magic", 16)
    .uint("frames", 16)
    .uint("width", 16)
    .uint("height", 16)
    .uint("depth", 16)
    .uint("flags", 32)
    .uint("speed", 16)
    .uint("next", 32)
    .uint("frit", 32)
    .uint("transparentIndex", 32)
    .uint("ignore0", 8)
    .uint("ignore1", 8)
    .uint("ignore2", 8)
    .uint("ncolors", 16)
    .uint("pixelWidth", 8)
    .uint("pixelHeight", 8)
    .int("gridX", 16)
    .int("gridY", 16)
    .uint("gridWidth", 16)
    .uint("gridHeight", 16)
    .flush();

  yield {
    type: HEADER,
    header,
  };

  parser.seek(headerPos + 128);

  for (let i = 0; i < header.frames; i++) {
    yield {
      type: FRAME,
      idx: i,
    };
    yield* chunks(parser);
  }
}

function* renderedFrames(stream) {
  let header;
  let frame;

  let elem = () => ({
    width: header.width,
    height: header.height,
    frame,
  });

  let layers = [];

  for (let ins of stream) {
    switch (ins.type) {
      case HEADER:
        header = ins.header;
        break;
      case FRAME:
        if (frame) {
          yield elem();
        }
        frame = Buffer.alloc(4 * header.width * header.height, 0);
        break;
      case LAYER:
        layers.push(ins);
        break;
      case CEL:
        // TODO: is it true that these will always come in the appropriate
        // order to render?
        let layer = layers[ins.layerIndex];
        if ((layer.flags & LAYER_VISIBLE) !== 0) {
          renderChunk(header, frame, ins);
        }
        break;
    }
  }
  if (frame) {
    yield elem();
  }
}

// https://github.com/aseprite/aseprite/blob/a5c36d0b0f3663d36a8105497458e86a41da310e/src/doc/blend_funcs.cpp#L202-L244
function renderChunk(header, buf, chunk) {
  for (let sy = 0; sy < chunk.h; sy++) {
    let dy = sy + chunk.y;
    if (dy < 0 || dy >= header.height) continue;
    for (let sx = 0; sx < chunk.w; sx++) {
      let dx = sx + chunk.x;
      if (dx < 0 || dx >= header.width) continue;

      let si = 4 * (sy * chunk.w + sx);
      let di = 4 * (dy * header.width + dx);

      let sr = chunk.data[si + 0];
      let sg = chunk.data[si + 1];
      let sb = chunk.data[si + 2];
      let sa = chunk.data[si + 3];

      let br = buf[di + 0];
      let bg = buf[di + 1];
      let bb = buf[di + 2];
      let ba = buf[di + 3];

      let ra = sa + ba - mul_un8(ba, sa);

      let rr = br + ~~(((sr - br) * sa) / ra);
      let rg = bg + ~~(((sg - bg) * sa) / ra);
      let rb = bb + ~~(((sb - bb) * sa) / ra);

      buf[di + 0] = rr;
      buf[di + 1] = rg;
      buf[di + 2] = rb;
      buf[di + 3] = ra;
    }
  }
}

function mul_un8(a, b) {
  let t = a * b + 0x80;
  return ((t >> 8) + t) >> 8;
}

function* chunks(parser) {
  // https://github.com/aseprite/aseprite/blob/main/src/dio/aseprite_decoder.cpp#L302
  parser
    .uint("size", 32)
    .uint("magic", 16)
    .uint("chunks", 16)
    .uint("duration", 16)
    .jump(2)
    // TODO: there's some weird thing with an nchunks thing here.
    .jump(4);
  // TODO: check magic is correct.
  let frameHeader = parser.flush();
  for (let j = 0; j < frameHeader.chunks; j++) {
    let chunkPos = parser.tell();
    let chunkHeader = parser
      .uint("chunkSize", 32)
      .uint("chunkType", 16)
      .flush();
    switch (chunkHeader.chunkType) {
      case ASE_FILE_CHUNK_COLOR_PROFILE:
        readColorProfile(parser);
        break;
      case ASE_FILE_CHUNK_PALETTE:
        // TODO
        break;
      case ASE_FILE_CHUNK_FLI_COLOR2:
        // TODO
        break;
      case ASE_FILE_CHUNK_LAYER:
        yield readLayerChunk(parser);
        break;
      case ASE_FILE_CHUNK_CEL:
        yield readCelChunk(parser, chunkPos, chunkHeader.chunkSize);
        break;
      default:
        console.log(
          "unhandled chunk type:",
          chunkHeader.chunkType.toString(16)
        );
    }
    parser.seek(chunkPos + chunkHeader.chunkSize);
  }
}

function readColorProfile(parser) {
  let header = parser
    .uint("type", 16)
    .uint("flags", 16)
    // this needs to be a fixed-point signed 32-bit integer(?)
    .uint("gamma", 32)
    .jump(8)
    .flush();
  switch (header.type) {
    case ASE_FILE_SRGB_COLOR_PROFILE:
      // TODO: don't actually do anything with this yet!
      break;
    default:
      // I suspect if there's a different one of these in use we need to do
      // something special.
      throw new Error("unhandled color space type:", header.type.toString(16));
  }
}

function pixelFormatFromDepth(depth) {
  switch (depth) {
    case 32:
      return COLORMODE_RGB;
    case 16:
      return COLORMODE_GRAYSCALE;
    default:
      return COLORMODE_INDEXED;
  }
}

function readCelChunk(parser, chunkPos, chunkSize) {
  let header = parser
    .uint("layerIndex", 16)
    // TODO: this should be signed
    .int("x", 16)
    .int("y", 16)
    .uint("opacity", 8)
    .uint("celType", 16)
    .jump(7)
    .flush();

  // TODO: aesprite does some error checking here.
  switch (header.celType) {
    case ASE_FILE_COMPRESSED_CEL:
      let subheader = parser.uint("w", 16).uint("h", 16).flush();
      let imageData = parser.sub(parser.tell(), chunkPos + chunkSize);
      return {
        type: CEL,
        layerIndex: header.layerIndex,
        w: subheader.w,
        h: subheader.h,
        x: header.x,
        y: header.y,
        opacity: header.opacity,
        data: inflateSync(imageData),
      };
    default:
      throw new Error(`unhandled cel type ${header.celType.toString(16)}`);
  }
}

function readLayerChunk(parser) {
  let header = parser
    .uint("flags", 16)
    .uint("layerType", 16)
    .uint("childLevel", 16)
    // Aseprite appears to ignore these.
    .uint("defaultWidth", 16)
    .uint("defaultHeight", 16)
    //
    // TODO: we should check that we support the blend mode here.
    .uint("blendMode", 16)
    .uint("opacity", 8)
    .jump(3)
    .string("name")
    .flush();

  header.type = LAYER;

  return header;
}

module.exports = { renderedFrames, parse };
