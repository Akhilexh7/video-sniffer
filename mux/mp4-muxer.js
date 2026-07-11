// mux/mp4-muxer.js

export function remuxMp4AndM4a(videoBuffer, audioBuffer) {
  console.log("[Muxer] Starting MP4 box-level remuxing...");
  
  const videoFtypInfo = getBoxOffsetAndSize(videoBuffer, 'ftyp');
  const videoMdatInfo = getBoxOffsetAndSize(videoBuffer, 'mdat');
  const audioMdatInfo = getBoxOffsetAndSize(audioBuffer, 'mdat');
  
  if (!videoFtypInfo || !videoMdatInfo || !audioMdatInfo) {
    throw new Error("Invalid input files: missing ftyp or mdat boxes");
  }
  
  const mvhdInfo = getBoxOffsetAndSize(videoBuffer, 'moov.mvhd');
  const videoTrakInfo = getBoxOffsetAndSize(videoBuffer, 'moov.trak');
  const audioTrakInfo = getBoxOffsetAndSize(audioBuffer, 'moov.trak');
  
  if (!mvhdInfo || !videoTrakInfo || !audioTrakInfo) {
    throw new Error("Invalid input files: missing moov sub-boxes");
  }
  
  console.log("[Muxer] Extracting box bytes...");
  const ftypBytes = new Uint8Array(videoBuffer.slice(videoFtypInfo.boxHeaderOffset, videoFtypInfo.offset + videoFtypInfo.size));
  const mvhdBytes = new Uint8Array(videoBuffer.slice(mvhdInfo.boxHeaderOffset, mvhdInfo.offset + mvhdInfo.size));
  
  const videoTrakBytes = new Uint8Array(videoBuffer.slice(videoTrakInfo.boxHeaderOffset, videoTrakInfo.offset + videoTrakInfo.size));
  const audioTrakBytes = new Uint8Array(audioBuffer.slice(audioTrakInfo.boxHeaderOffset, audioTrakInfo.offset + audioTrakInfo.size));
  
  console.log("[Muxer] Setting audio track ID to 2...");
  const audioTkhdInfo = getBoxOffsetAndSize(audioTrakBytes.buffer, 'trak.tkhd');
  if (audioTkhdInfo) {
    const view = new DataView(audioTrakBytes.buffer, audioTkhdInfo.offset, audioTkhdInfo.size);
    const version = view.getUint8(0);
    const idOffset = version === 1 ? 20 : 12;
    view.setUint32(idOffset, 2);
  }
  
  const newMoovPayloadSize = mvhdBytes.length + videoTrakBytes.length + audioTrakBytes.length;
  const newMoovSize = 8 + newMoovPayloadSize;
  const newHeaderSize = ftypBytes.length + newMoovSize;
  
  const newVideoSampleStart = newHeaderSize + 8; // ftyp + moov + 8 bytes mdat header
  const videoShift = newVideoSampleStart - videoMdatInfo.offset;
  
  console.log(`[Muxer] Shifting video track offsets by ${videoShift}...`);
  const videoStco = getBoxOffsetAndSize(videoTrakBytes.buffer, 'trak.mdia.minf.stbl.stco');
  if (videoStco) {
    shiftStco(videoTrakBytes.buffer, videoStco.offset, videoStco.size, videoShift);
  } else {
    const videoCo64 = getBoxOffsetAndSize(videoTrakBytes.buffer, 'trak.mdia.minf.stbl.co64');
    if (videoCo64) {
      shiftCo64(videoTrakBytes.buffer, videoCo64.offset, videoCo64.size, videoShift);
    }
  }
  
  const newAudioSampleStart = newVideoSampleStart + videoMdatInfo.size;
  const audioShift = newAudioSampleStart - audioMdatInfo.offset;
  
  console.log(`[Muxer] Shifting audio track offsets by ${audioShift}...`);
  const audioStco = getBoxOffsetAndSize(audioTrakBytes.buffer, 'trak.mdia.minf.stbl.stco');
  if (audioStco) {
    shiftStco(audioTrakBytes.buffer, audioStco.offset, audioStco.size, audioShift);
  } else {
    const audioCo64 = getBoxOffsetAndSize(audioTrakBytes.buffer, 'trak.mdia.minf.stbl.co64');
    if (audioCo64) {
      shiftCo64(audioTrakBytes.buffer, audioCo64.offset, audioCo64.size, audioShift);
    }
  }
  
  // Update next_track_ID to 3 in mvhd
  const mvhdView = new DataView(mvhdBytes.buffer, mvhdBytes.byteOffset + (mvhdInfo.offset - mvhdInfo.boxHeaderOffset), mvhdInfo.size);
  const mvhdVersion = mvhdView.getUint8(0);
  const nextTrackIdOffset = mvhdVersion === 1 ? 108 : 96;
  if (nextTrackIdOffset + 4 <= mvhdInfo.size) {
    mvhdView.setUint32(nextTrackIdOffset, 3);
  }
  
  console.log("[Muxer] Writing merged file buffer...");
  const totalLength = newHeaderSize + 8 + videoMdatInfo.size + audioMdatInfo.size;
  const outBuffer = new ArrayBuffer(totalLength);
  const outView = new Uint8Array(outBuffer);
  
  let writeOffset = 0;
  outView.set(ftypBytes, writeOffset);
  writeOffset += ftypBytes.length;
  
  // Write new moov box
  const moovHeader = new Uint8Array(8);
  const moovHeaderView = new DataView(moovHeader.buffer);
  moovHeaderView.setUint32(0, newMoovSize);
  moovHeader.set([109, 111, 111, 118], 4); // "moov"
  outView.set(moovHeader, writeOffset);
  writeOffset += 8;
  
  outView.set(mvhdBytes, writeOffset);
  writeOffset += mvhdBytes.length;
  
  outView.set(videoTrakBytes, writeOffset);
  writeOffset += videoTrakBytes.length;
  
  outView.set(audioTrakBytes, writeOffset);
  writeOffset += audioTrakBytes.length;
  
  // Write mdat box header
  const mdatHeader = new Uint8Array(8);
  const mdatHeaderView = new DataView(mdatHeader.buffer);
  const totalMdatSize = 8 + videoMdatInfo.size + audioMdatInfo.size;
  mdatHeaderView.setUint32(0, totalMdatSize);
  mdatHeader.set([109, 100, 97, 116], 4); // "mdat"
  outView.set(mdatHeader, writeOffset);
  writeOffset += 8;
  
  // Write video samples
  const videoSamples = new Uint8Array(videoBuffer, videoMdatInfo.offset, videoMdatInfo.size);
  outView.set(videoSamples, writeOffset);
  writeOffset += videoMdatInfo.size;
  
  // Write audio samples
  const audioSamples = new Uint8Array(audioBuffer, audioMdatInfo.offset, audioMdatInfo.size);
  outView.set(audioSamples, writeOffset);
  
  console.log("[Muxer] Box remuxing complete. Created merged MP4 Blob.");
  return new Blob([outBuffer], { type: "video/mp4" });
}

function getBoxOffsetAndSize(buffer, path) {
  const parts = path.split('.');
  let offset = 0;
  let size = buffer.byteLength;
  const view = new DataView(buffer);
  
  for (const part of parts) {
    let found = false;
    let subOffset = offset;
    const end = offset + size;
    let boxHeaderOffset = 0;
    while (subOffset < end) {
      if (subOffset + 8 > end) break;
      let boxSize = view.getUint32(subOffset);
      const typeBytes = new Uint8Array(buffer, subOffset + 4, 4);
      const type = String.fromCharCode(...typeBytes);
      let headerSize = 8;
      if (boxSize === 1) {
        if (subOffset + 16 > end) break;
        const high = view.getUint32(subOffset + 8);
        const low = view.getUint32(subOffset + 12);
        boxSize = high * 0x100000000 + low;
        headerSize = 16;
      }
      const actualSize = boxSize === 0 ? end - subOffset : boxSize;
      if (type === part) {
        boxHeaderOffset = subOffset;
        offset = subOffset + headerSize;
        size = actualSize - headerSize;
        found = true;
        break;
      }
      subOffset += actualSize;
    }
    if (!found) return null;
    if (part === parts[parts.length - 1]) {
      return { offset, size, boxHeaderOffset };
    }
  }
  return null;
}

function shiftStco(buffer, offset, size, shift) {
  const view = new DataView(buffer, offset, size);
  const entryCount = view.getUint32(4);
  let subOffset = 8;
  for (let i = 0; i < entryCount; i++) {
    const val = view.getUint32(subOffset);
    view.setUint32(subOffset, val + shift);
    subOffset += 4;
  }
}

function shiftCo64(buffer, offset, size, shift) {
  const view = new DataView(buffer, offset, size);
  const entryCount = view.getUint32(4);
  let subOffset = 8;
  for (let i = 0; i < entryCount; i++) {
    const high = view.getUint32(subOffset);
    const low = view.getUint32(subOffset + 4);
    const val = high * 0x100000000 + low;
    const newVal = val + shift;
    view.setUint32(subOffset, Math.floor(newVal / 0x100000000));
    view.setUint32(subOffset + 4, newVal % 0x100000000);
    subOffset += 8;
  }
}

export function remuxFragmentedMp4(videoInit, audioInit, videoSegments, audioSegments) {
  console.log("[Muxer] Starting fragmented MP4 box-level remuxing...");

  const videoFtypInfo = getBoxOffsetAndSize(videoInit, 'ftyp');
  const mvhdInfo = getBoxOffsetAndSize(videoInit, 'moov.mvhd');
  const videoTrakInfo = getBoxOffsetAndSize(videoInit, 'moov.trak');
  const audioTrakInfo = getBoxOffsetAndSize(audioInit, 'moov.trak');

  if (!videoFtypInfo || !mvhdInfo || !videoTrakInfo || !audioTrakInfo) {
    throw new Error("Invalid input fragmented MP4 init segment files: missing ftyp, mvhd, or trak boxes");
  }

  const videoTrexInfo = getBoxOffsetAndSize(videoInit, 'moov.mvex.trex');
  const audioTrexInfo = getBoxOffsetAndSize(audioInit, 'moov.mvex.trex');

  console.log("[Muxer] Extracting box bytes for fragmented MP4...");
  const ftypBytes = new Uint8Array(videoInit.slice(videoFtypInfo.boxHeaderOffset, videoFtypInfo.offset + videoFtypInfo.size));
  const mvhdBytes = new Uint8Array(videoInit.slice(mvhdInfo.boxHeaderOffset, mvhdInfo.offset + mvhdInfo.size));
  
  // Update next_track_ID to 3 in mvhd
  const mvhdView = new DataView(mvhdBytes.buffer, mvhdBytes.byteOffset + (mvhdInfo.offset - mvhdInfo.boxHeaderOffset), mvhdInfo.size);
  const mvhdVersion = mvhdView.getUint8(0);
  const nextTrackIdOffset = mvhdVersion === 1 ? 108 : 96;
  if (nextTrackIdOffset + 4 <= mvhdInfo.size) {
    mvhdView.setUint32(nextTrackIdOffset, 3);
  }
  
  const videoTrakBytes = new Uint8Array(videoInit.slice(videoTrakInfo.boxHeaderOffset, videoTrakInfo.offset + videoTrakInfo.size));
  const audioTrakBytes = new Uint8Array(audioInit.slice(audioTrakInfo.boxHeaderOffset, audioTrakInfo.offset + audioTrakInfo.size));

  console.log("[Muxer] Setting fragmented audio track ID to 2...");
  const audioTkhdInfo = getBoxOffsetAndSize(audioTrakBytes.buffer, 'trak.tkhd');
  if (audioTkhdInfo) {
    const view = new DataView(audioTrakBytes.buffer, audioTrakBytes.byteOffset + audioTkhdInfo.offset, audioTkhdInfo.size);
    const version = view.getUint8(0);
    const idOffset = version === 1 ? 20 : 12;
    view.setUint32(idOffset, 2);
  }

  // Handle mvex and trex boxes
  let mvexBox = null;
  if (videoTrexInfo && audioTrexInfo) {
    const videoTrexBytes = new Uint8Array(videoInit.slice(videoTrexInfo.boxHeaderOffset, videoTrexInfo.offset + videoTrexInfo.size));
    const audioTrexBytes = new Uint8Array(audioInit.slice(audioTrexInfo.boxHeaderOffset, audioTrexInfo.offset + audioTrexInfo.size));

    const audioTrexPayloadView = new DataView(audioTrexBytes.buffer, audioTrexBytes.byteOffset, audioTrexBytes.byteLength);
    audioTrexPayloadView.setUint32(12, 2);

    const newMvexPayloadSize = videoTrexBytes.length + audioTrexBytes.length;
    const newMvexSize = 8 + newMvexPayloadSize;
    mvexBox = new Uint8Array(newMvexSize);
    const mvexView = new DataView(mvexBox.buffer);
    mvexView.setUint32(0, newMvexSize);
    mvexBox.set([109, 118, 101, 120], 4); // "mvex"
    mvexBox.set(videoTrexBytes, 8);
    mvexBox.set(audioTrexBytes, 8 + videoTrexBytes.length);
  }

  const newMoovPayloadSize = mvhdBytes.length + videoTrakBytes.length + audioTrakBytes.length + (mvexBox ? mvexBox.length : 0);
  const newMoovSize = 8 + newMoovPayloadSize;

  const mergedInitBuffer = new ArrayBuffer(ftypBytes.length + newMoovSize);
  const outView = new Uint8Array(mergedInitBuffer);

  let writeOffset = 0;
  outView.set(ftypBytes, writeOffset);
  writeOffset += ftypBytes.length;

  const moovHeader = new Uint8Array(8);
  const moovHeaderView = new DataView(moovHeader.buffer);
  moovHeaderView.setUint32(0, newMoovSize);
  moovHeader.set([109, 111, 111, 118], 4); // "moov"
  outView.set(moovHeader, writeOffset);
  writeOffset += 8;

  outView.set(mvhdBytes, writeOffset);
  writeOffset += mvhdBytes.length;

  outView.set(videoTrakBytes, writeOffset);
  writeOffset += videoTrakBytes.length;

  outView.set(audioTrakBytes, writeOffset);
  writeOffset += audioTrakBytes.length;

  if (mvexBox) {
    outView.set(mvexBox, writeOffset);
    writeOffset += mvexBox.length;
  }

  console.log("[Muxer] Merged init segment created. Rewriting track IDs in audio media segments...");
  const processedAudioSegments = audioSegments.map((segBuffer) => {
    // Copy the buffer to avoid modifying in-memory segment cache
    const copyBuffer = segBuffer.slice(0);
    rewriteTfhdTrackId(copyBuffer, 2);
    return copyBuffer;
  });

  console.log("[Muxer] Combining and interleaving all fMP4 components...");
  const finalBuffers = [mergedInitBuffer];
  const maxLen = Math.max(videoSegments.length, processedAudioSegments.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < videoSegments.length) {
      finalBuffers.push(videoSegments[i]);
    }
    if (i < processedAudioSegments.length) {
      finalBuffers.push(processedAudioSegments[i]);
    }
  }

  return new Blob(finalBuffers, { type: "video/mp4" });
}

function rewriteTfhdTrackId(buffer, targetTrackId) {
  const view = new DataView(buffer);
  const len = buffer.byteLength;
  let offset = 0;

  while (offset + 8 <= len) {
    const boxSize = view.getUint32(offset);
    const boxType = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7)
    );

    const actualSize = boxSize === 1 ? (view.getUint32(offset + 8) * 0x100000000 + view.getUint32(offset + 12)) : boxSize;
    const headerSize = boxSize === 1 ? 16 : 8;

    if (boxType === "moof") {
      let subOffset = offset + headerSize;
      const moofEnd = offset + (boxSize === 0 ? len - offset : actualSize);
      while (subOffset + 8 <= moofEnd) {
        const subSize = view.getUint32(subOffset);
        const subType = String.fromCharCode(
          view.getUint8(subOffset + 4),
          view.getUint8(subOffset + 5),
          view.getUint8(subOffset + 6),
          view.getUint8(subOffset + 7)
        );
        const subActualSize = subSize === 1 ? (view.getUint32(subOffset + 8) * 0x100000000 + view.getUint32(subOffset + 12)) : subSize;
        const subHeaderSize = subSize === 1 ? 16 : 8;

        if (subType === "traf") {
          let trafOffset = subOffset + subHeaderSize;
          const trafEnd = subOffset + subActualSize;
          while (trafOffset + 8 <= trafEnd) {
            const trafSubSize = view.getUint32(trafOffset);
            const trafSubType = String.fromCharCode(
              view.getUint8(trafOffset + 4),
              view.getUint8(trafOffset + 5),
              view.getUint8(trafOffset + 6),
              view.getUint8(trafOffset + 7)
            );

            if (trafSubType === "tfhd") {
              if (trafOffset + 16 <= len) {
                view.setUint32(trafOffset + 12, targetTrackId);
              }
              break;
            }
            trafOffset += (trafSubSize === 1 ? (view.getUint32(trafOffset + 8) * 0x100000000 + view.getUint32(trafOffset + 12)) : trafSubSize);
          }
        }
        subOffset += subActualSize;
      }
    }

    offset += (boxSize === 0 ? len - offset : actualSize);
  }
}
