import { BadRequestException } from '@nestjs/common';
import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';
import { EXCEL_IMPORT_LIMITS as limits } from './excel-import-limits';

interface ZipContentStream {
  on(event: 'data', callback: (chunk: Buffer) => void): ZipContentStream;
  on(event: 'error', callback: (error: Error) => void): ZipContentStream;
  on(event: 'end', callback: () => void): ZipContentStream;
  pause(): void;
  resume(): void;
}

interface XmlNode {
  name: string;
  attributes: Record<string, string>;
}

interface XmlParser {
  on(event: 'opentag', callback: (node: XmlNode) => void): void;
  on(event: 'closetag', callback: () => void): void;
  on(event: 'doctype', callback: () => void): void;
  write(text: string): XmlParser;
  close(): void;
}

// Reuse ExcelJS's installed parsers without adding a second ZIP/XML dependency.
const excelRequire = createRequire(require.resolve('exceljs'));
const zipParser = excelRequire('jszip') as {
  loadAsync(buffer: Buffer): Promise<{
    files: Record<
      string,
      { dir: boolean; internalStream(type: 'nodebuffer'): ZipContentStream }
    >;
  }>;
};
const { SaxesParser } = excelRequire('saxes') as {
  SaxesParser: new () => XmlParser;
};

function reject(message: string): never {
  throw new BadRequestException(message);
}

function checkIndex(value: string, maximum: number, label: string) {
  if (!/^[1-9]\d*$/.test(value) || Number(value) > maximum) {
    reject(`Excel ${label} limit (${maximum}) exceeded or invalid index.`);
  }
}

function checkAddress(address: string) {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(address);
  if (!match) reject('Excel cell address is not valid.');
  const column = [...match[1]].reduce(
    (value, letter) => value * 26 + letter.charCodeAt(0) - 64,
    0,
  );
  checkIndex(String(column), limits.columns, 'column');
  checkIndex(match[2], limits.rows + 1, 'row');
}

export async function validateExcelArchive(buffer: Buffer) {
  // Bound ZIP directory allocation before the library reads any entries.
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (
    end < 0 ||
    end + 22 > buffer.length ||
    end + 22 + buffer.readUInt16LE(end + 20) !== buffer.length ||
    buffer.readUInt16LE(end + 4) !== 0 ||
    buffer.readUInt16LE(end + 6) !== 0 ||
    buffer.readUInt16LE(end + 8) !== buffer.readUInt16LE(end + 10) ||
    buffer.readUInt32LE(end + 12) > limits.archiveEntries * 256 ||
    buffer.readUInt32LE(end + 16) + buffer.readUInt32LE(end + 12) !== end
  ) {
    reject('File Excel is not valid.');
  }
  if (buffer.readUInt16LE(end + 10) > limits.archiveEntries) {
    reject(`Excel archive entry limit (${limits.archiveEntries}) exceeded.`);
  }

  const archive = await zipParser.loadAsync(buffer);
  const entries = Object.entries(archive.files);
  if (entries.length > limits.archiveEntries) {
    reject(`Excel archive entry limit (${limits.archiveEntries}) exceeded.`);
  }
  const worksheetEntries = entries.filter(([name]) =>
    /xl\/worksheets\/sheet\d+\.xml/.test(name),
  );
  if (worksheetEntries.length > limits.worksheets) {
    reject(`Excel worksheet limit (${limits.worksheets}) exceeded.`);
  }

  let expandedSize = 0;
  let cells = 0;
  let xmlNodes = 0;
  let worksheets = 0;
  for (const [name, entry] of entries) {
    if (entry.dir) continue;
    const decoder = new StringDecoder('utf8');
    const isWorksheet = /xl\/worksheets\/sheet\d+\.xml/.test(name);
    const parser = /\.(?:xml|rels)/.test(name) ? new SaxesParser() : undefined;
    let rows = 0;
    let depth = 0;
    parser?.on('doctype', () =>
      reject('Excel XML document types are not supported.'),
    );
    parser?.on('closetag', () => {
      depth--;
    });
    parser?.on('opentag', ({ name: tag, attributes }) => {
      if (++depth > limits.xmlDepth) {
        reject(`Excel XML nesting limit (${limits.xmlDepth}) exceeded.`);
      }
      if (++xmlNodes > limits.xmlNodes) {
        reject(`Excel XML node limit (${limits.xmlNodes}) exceeded.`);
      }
      if (name === 'xl/workbook.xml' || name === '/xl/workbook.xml') {
        if (tag === 'definedName') {
          reject('Excel named ranges are not supported for import.');
        }
        if (tag === 'sheet') {
          if (++worksheets > limits.worksheets) {
            reject(`Excel worksheet limit (${limits.worksheets}) exceeded.`);
          }
          checkIndex(attributes.sheetId, limits.xmlNodes, 'worksheet ID');
        }
      }
      if (!isWorksheet) return;
      if (tag === 'row') {
        if (++rows > limits.rows + 1) {
          reject(`Excel data row limit (${limits.rows}) exceeded.`);
        }
        checkIndex(attributes.r, limits.rows + 1, 'row');
      } else if (tag === 'c') {
        if (++cells > limits.cells) {
          reject(`Excel cell limit (${limits.cells}) exceeded.`);
        }
        checkAddress(attributes.r);
      } else if (tag === 'col') {
        checkIndex(attributes.min, limits.columns, 'column');
        checkIndex(attributes.max, limits.columns, 'column');
      } else if (tag === 'dimension') {
        attributes.ref.split(':').forEach(checkAddress);
      } else if (tag === 'mergeCell') {
        reject('Excel merged cells are not supported for import.');
      }
    });

    await new Promise<void>((resolve, rejectPromise) => {
      const content = entry.internalStream('nodebuffer');
      content.on('data', (chunk) => {
        try {
          expandedSize += chunk.length;
          if (expandedSize > limits.expandedSize) {
            reject(
              `Excel expanded size limit (${limits.expandedSize} bytes) exceeded.`,
            );
          }
          parser?.write(decoder.write(chunk));
        } catch (error) {
          content.pause();
          rejectPromise(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
      content.on('error', rejectPromise);
      content.on('end', () => {
        try {
          parser?.write(decoder.end()).close();
          resolve();
        } catch (error) {
          rejectPromise(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
      content.resume();
    });
  }
}
