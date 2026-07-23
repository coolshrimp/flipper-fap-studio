import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

export interface DesktopAssetImage {
    width: number;
    height: number;
    bytes: Uint8Array;
}

export interface DesktopAssetGenerationResult {
    headerCount: number;
    warnings: string[];
}

function collectAssetFiles(root: string): string[] {
    const result: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) result.push(...collectAssetFiles(full));
        else if (/\.(?:png|pbm)$/i.test(entry.name)) result.push(full);
    }
    return result;
}

function packPixels(width: number, height: number, isBlack: (x: number, y: number) => boolean): Uint8Array {
    const rowBytes = Math.ceil(width / 8);
    const packed = new Uint8Array(rowBytes * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (isBlack(x, y)) packed[y * rowBytes + Math.floor(x / 8)] |= 1 << (x % 8);
        }
    }
    return packed;
}

export function decodePngAsset(buffer: Buffer): DesktopAssetImage {
    if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("not a PNG");
    let offset = 8;
    let width = 0;
    let height = 0;
    let depth = 0;
    let colorType = 0;
    let interlace = 0;
    let palette: Buffer | undefined;
    let transparency: Buffer | undefined;
    const idat: Buffer[] = [];
    while (offset + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        if (offset + length + 12 > buffer.length) throw new Error("truncated PNG chunk");
        const type = buffer.toString("ascii", offset + 4, offset + 8);
        const data = buffer.subarray(offset + 8, offset + 8 + length);
        if (type === "IHDR") {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            depth = data[8];
            colorType = data[9];
            interlace = data[12];
        } else if (type === "PLTE") {
            palette = data;
        } else if (type === "tRNS") {
            transparency = data;
        } else if (type === "IDAT") {
            idat.push(data);
        } else if (type === "IEND") {
            break;
        }
        offset += length + 12;
    }
    if (!width || !height || ![1, 2, 4, 8].includes(depth)) {
        throw new Error("only 1, 2, 4, or 8-bit PNG assets are supported");
    }
    if (interlace !== 0) throw new Error("interlaced PNG is unsupported");
    const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
    if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);
    if (depth !== 8 && channels !== 1) throw new Error(`unsupported ${depth}-bit PNG color type ${colorType}`);
    const stride = Math.ceil(width * channels * depth / 8);
    const filterBytesPerPixel = Math.max(1, Math.ceil(channels * depth / 8));
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const expectedLength = (stride + 1) * height;
    if (raw.length < expectedLength) throw new Error("truncated PNG pixels");
    const pixels = Buffer.alloc(stride * height);
    let source = 0;
    for (let y = 0; y < height; y++) {
        const filter = raw[source++];
        for (let x = 0; x < stride; x++) {
            const value = raw[source++];
            const left = x >= filterBytesPerPixel ? pixels[y * stride + x - filterBytesPerPixel] : 0;
            const up = y ? pixels[(y - 1) * stride + x] : 0;
            const upLeft = y && x >= filterBytesPerPixel
                ? pixels[(y - 1) * stride + x - filterBytesPerPixel]
                : 0;
            let prediction = 0;
            if (filter === 1) prediction = left;
            else if (filter === 2) prediction = up;
            else if (filter === 3) prediction = Math.floor((left + up) / 2);
            else if (filter === 4) {
                const p = left + up - upLeft;
                const pa = Math.abs(p - left);
                const pb = Math.abs(p - up);
                const pc = Math.abs(p - upLeft);
                prediction = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
            } else if (filter !== 0) {
                throw new Error(`unsupported PNG filter ${filter}`);
            }
            pixels[y * stride + x] = (value + prediction) & 0xff;
        }
    }
    const sample = (x: number, y: number, channel = 0): number => {
        if (depth === 8) return pixels[y * stride + x * channels + channel];
        const bitOffset = x * depth;
        const shift = 8 - depth - (bitOffset % 8);
        return (pixels[y * stride + Math.floor(bitOffset / 8)] >> shift) & ((1 << depth) - 1);
    };
    const bytes = packPixels(width, height, (x, y) => {
        const raw = sample(x, y);
        const scaled = depth === 8 ? raw : Math.round(raw * 255 / ((1 << depth) - 1));
        let red = scaled;
        let green = red;
        let blue = red;
        let alpha = 255;
        if (colorType === 2 || colorType === 6) {
            green = sample(x, y, 1);
            blue = sample(x, y, 2);
            if (colorType === 6) alpha = sample(x, y, 3);
        } else if (colorType === 4) {
            alpha = sample(x, y, 1);
        } else if (colorType === 3 && palette) {
            const paletteIndex = raw;
            red = palette[paletteIndex * 3] ?? 255;
            green = palette[paletteIndex * 3 + 1] ?? 255;
            blue = palette[paletteIndex * 3 + 2] ?? 255;
            alpha = transparency?.[paletteIndex] ?? 255;
        }
        return alpha > 31 && (red * 299 + green * 587 + blue * 114) / 1000 < 160;
    });
    return { width, height, bytes };
}

export function decodePbmAsset(buffer: Buffer): DesktopAssetImage {
    let offset = 0;
    const token = (): string => {
        while (offset < buffer.length) {
            const character = buffer[offset];
            if (character === 35) {
                while (offset < buffer.length && buffer[offset] !== 10 && buffer[offset] !== 13) offset++;
            } else if (character <= 32) {
                offset++;
            } else {
                break;
            }
        }
        const start = offset;
        while (offset < buffer.length && buffer[offset] > 32 && buffer[offset] !== 35) offset++;
        return buffer.toString("ascii", start, offset);
    };
    const format = token();
    const width = Number(token());
    const height = Number(token());
    if ((format !== "P1" && format !== "P4") || !width || !height) throw new Error("invalid PBM asset");
    const rowBytes = Math.ceil(width / 8);
    if (format === "P4") {
        while (offset < buffer.length && buffer[offset] <= 32) offset++;
        if (buffer.length - offset < rowBytes * height) throw new Error("truncated binary PBM pixels");
        const bytes = new Uint8Array(rowBytes * height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const sourceBit = buffer[offset + y * rowBytes + Math.floor(x / 8)] & (0x80 >> (x % 8));
                if (sourceBit) bytes[y * rowBytes + Math.floor(x / 8)] |= 1 << (x % 8);
            }
        }
        return { width, height, bytes };
    }
    const bytes = packPixels(width, height, () => token() === "1");
    return { width, height, bytes };
}

function placeholderBitmap(width: number, height: number): Uint8Array {
    return packPixels(
        width,
        height,
        (x, y) => x === 0 || y === 0 || x === width - 1 || y === height - 1 || x === y || x === width - y - 1,
    );
}

export async function generateDesktopAssetHeaders(
    appFolder: string,
    buildRoot: string,
    sources: string[],
): Promise<DesktopAssetGenerationResult> {
    const sourceText = sources.map(source => fs.readFileSync(source, "utf8")).join("\n");
    const headerNames = [...sourceText.matchAll(/#include\s*"([A-Za-z0-9_./-]+_icons\.h)"/g)]
        .map(match => match[1])
        .filter((name, index, all) => all.indexOf(name) === index)
        .filter(name => !fs.existsSync(path.resolve(appFolder, name)));
    if (!headerNames.length) return { headerCount: 0, warnings: [] };

    const manifestPath = path.join(appFolder, "application.fam");
    const manifest = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, "utf8") : "";
    const assetFolderName = /fap_icon_assets\s*=\s*["']([^"']+)/.exec(manifest)?.[1] || "images";
    const assetFolder = path.resolve(appFolder, assetFolderName);
    const images = fs.existsSync(assetFolder) ? collectAssetFiles(assetFolder) : [];
    const decoded = new Map<string, DesktopAssetImage>();
    const warnings: string[] = [];
    for (const imagePath of images) {
        try {
            const image = imagePath.toLowerCase().endsWith(".png")
                ? decodePngAsset(fs.readFileSync(imagePath))
                : decodePbmAsset(fs.readFileSync(imagePath));
            const symbol = `I_${path.basename(imagePath, path.extname(imagePath)).replace(/[^A-Za-z0-9_]/g, "_")}`;
            decoded.set(symbol, image);
        } catch (error) {
            warnings.push(`${path.basename(imagePath)}: ${String(error)}`);
        }
    }

    const referencedSymbols = [...sourceText.matchAll(/\b(I_[A-Za-z0-9_]+)\b/g)]
        .map(match => match[1])
        .filter((name, index, all) => all.indexOf(name) === index);
    for (const symbol of referencedSymbols) {
        if (decoded.has(symbol)) continue;
        const dimensions = /_(\d+)x(\d+)(?:_\d+)?$/.exec(symbol);
        const width = dimensions ? Number(dimensions[1]) : 10;
        const height = dimensions ? Number(dimensions[2]) : 10;
        decoded.set(symbol, { width, height, bytes: placeholderBitmap(width, height) });
        warnings.push(`${symbol}: source asset not found; using a ${width}x${height} placeholder`);
    }

    const header = [
        "#pragma once",
        "#include <gui/icon.h>",
        ...[...decoded.entries()].flatMap(([symbol, image], index) => {
            const bytes = [...image.bytes].map(value => `0x${value.toString(16).padStart(2, "0")}`).join(",");
            const base = `runtime_icon_${index}`;
            return [
                `static const uint8_t ${base}_data[] = {${bytes}};`,
                `static const uint8_t* const ${base}_frames[] = {${base}_data};`,
                `static const Icon ${symbol} = {${image.width},${image.height},1,${base}_frames};`,
            ];
        }),
        "",
    ].join("\n");
    await Promise.all(headerNames.map(async name => {
        const output = path.resolve(buildRoot, name);
        if (path.relative(buildRoot, output).startsWith("..")) throw new Error(`unsafe generated asset header path: ${name}`);
        await fs.promises.mkdir(path.dirname(output), { recursive: true });
        await fs.promises.writeFile(output, header, "utf8");
    }));
    return { headerCount: headerNames.length, warnings };
}
