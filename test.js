const assert = require("assert");
const fs = require("fs");
const glob = require("glob");
const { PNG } = require("pngjs");
const { parse, renderFrames } = require("./index");
const { execFile } = require("child_process");

let idx = process.argv.indexOf("--regen");

let binary = null;
if (idx > -1) {
  binary = process.argv[idx + 1];
}

function canonical(binary, from, to) {
  return new Promise(function (resolve, reject) {
    execFile(
      binary,
      ["--batch", from, "--save-as", to],
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          try {
            resolve();
          } catch (e) {
            reject(stderr);
          }
        }
      }
    );
  });
}

describe("parser", () => {
  describe("slice data", () => {
    it("parses slice data", () => {
      let fname = "ases/slices.ase";
      let parsed = parse(fname);
      let slices = [];
      for (let p of parsed) {
        switch (p.type) {
          case "SLICE":
            slices.push(p);
        }
      }

      assert.deepStrictEqual(slices, [
        {
          type: "SLICE",
          name: "top left",
          keys: [
            {
              frame: 0,
              bounds: { x: 0, y: 0, w: 5, h: 5 },
              center: { x: 0, y: 0, w: 0, h: 0 },
              pivot: { x: 0, y: 0 },
            },
          ],
        },
        {
          type: "SLICE",
          name: "top right",
          keys: [
            {
              frame: 0,
              bounds: { x: 11, y: 0, w: 5, h: 5 },
              center: { x: 0, y: 0, w: 0, h: 0 },
              pivot: { x: 2, y: 2 },
            },
          ],
        },
        {
          type: "SLICE",
          name: "bottom left",
          keys: [
            {
              frame: 0,
              bounds: { x: 0, y: 8, w: 8, h: 8 },
              center: { x: 1, y: 2, w: 3, h: 4 },
              pivot: { x: 0, y: 0 },
            },
          ],
        },
      ]);
    });
  });

  describe("parses tag data", () => {
    it("can parse the frog king sprite", () => {
      let fname = "ases/frog.ase";
      let parsed = parse(fname);
      for (let p of parsed) {
        switch (p.type) {
          case "TAGS":
            assert.deepStrictEqual(p, {
              type: "TAGS",
              tags: [
                { from: 0, to: 3, anidir: 0, r: 0, g: 0, b: 0, name: "idle" },
                { from: 4, to: 11, anidir: 0, r: 0, g: 0, b: 0, name: "jump" },
              ],
            });
            break;
        }
      }
    });
  });

  describe("can create pngs from ases", () => {
    for (let ase of glob.sync("testdata/*.ase")) {
      it(`handles ${ase}`, () => {
        let basename = ase.slice(0, -".ase".length);
        let outFname = basename + ".{frame}.out.png";

        let parsed = parse(ase);
        let frameCount = 0;
        for (let frame of renderFrames(parsed)) {
          let png = new PNG({ width: frame.width, height: frame.height });
          png.data = frame.frame;
          fs.writeFileSync(
            outFname.replace("{frame}", frameCount),
            PNG.sync.write(png)
          );
          frameCount++;
        }

        let expectedFname = basename + ".{frame}.ase.png";

        let p = Promise.resolve();
        if (binary !== null) {
          p = Promise.all([canonical(binary, ase, expectedFname)]);
        }
        return p.then(() => {
          // Random formatting differences(?) mean the bytes of the actual files
          // are different so we have to load them in via pngjs and compare the
          // bytes.
          for (let i = 0; i < frameCount; i++) {
            let actual = PNG.sync.read(
              fs.readFileSync(outFname.replace("{frame}", i))
            );
            let expected = PNG.sync.read(
              fs.readFileSync(expectedFname.replace("{frame}", i))
            );

            assert.deepStrictEqual(actual.data, expected.data);
          }
        });
      });
    }
  });
});
