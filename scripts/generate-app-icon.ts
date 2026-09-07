import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const repoRoot = path.resolve(import.meta.dirname, "..");
const svgPath = path.join(repoRoot, "packaging/assets/compet-icon.svg");
const icoPath = path.join(repoRoot, "packaging/assets/compet-icon.ico");
const sizes = [16, 24, 32, 48, 64, 128, 256] as const;

function encodeIco(images: Array<{ size: number; png: Buffer }>): Buffer {
  const directorySize = 6 + images.length * 16;
  const header = Buffer.alloc(directorySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let imageOffset = directorySize;

  images.forEach(({ size, png }, index) => {
    const cursor = 6 + index * 16;
    header[cursor] = size === 256 ? 0 : size;
    header[cursor + 1] = size === 256 ? 0 : size;
    header[cursor + 2] = 0;
    header[cursor + 3] = 0;
    header.writeUInt16LE(1, cursor + 4);
    header.writeUInt16LE(32, cursor + 6);
    header.writeUInt32LE(png.length, cursor + 8);
    header.writeUInt32LE(imageOffset, cursor + 12);
    imageOffset += png.length;
  });

  return Buffer.concat([header, ...images.map(({ png }) => png)]);
}

const svg = await readFile(svgPath);
const images = await Promise.all(
  sizes.map(async (size) => ({
    size,
    png: await sharp(svg, { density: 384 })
      .resize(size, size, { fit: "fill" })
      .ensureAlpha()
      .png({ compressionLevel: 9, palette: false })
      .toBuffer(),
  })),
);

await writeFile(icoPath, encodeIco(images));
console.log(`Generated ${path.relative(repoRoot, icoPath)} with ${sizes.length} layers`);
