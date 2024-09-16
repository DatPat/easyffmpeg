// Import required modules
const chokidar = require('chokidar');
const fs = require('fs').promises;
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

// Supported file extensions
const videoExtensions = ['.mp4', '.mkv', '.m4v'];
const subtitleExtensions = ['.srt', '.ass', '.sub', '.ssa', '.smi', '.vtt'];

// Utility functions
function parseEnvBoolean(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  return value === '1' || value.toLowerCase() === 'true';
}

function parseEnvInt(value, defaultValue = 0) {
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

// Configuration
const config = {
  // Directories
  watchDir: process.env.WATCH_DIR || '/watch',
  tempDir: process.env.TEMP_DIR || '/temp',
  completeDir: process.env.COMPLETE_DIR || '/ready',

  // Video encoding settings
  videoBitRate: process.env.VIDEO_BIT_RATE || '4M',
  videoCodec: process.env.VIDEO_CODEC || 'av1',
  videoAccelApi: process.env.VIDEO_ACCEL_API || 'va',
  workDevice: process.env.WORK_DEVICE || '/dev/dri/renderD128',

  // Processing options
  deleteSourceFile: parseEnvBoolean(process.env.DELETE_SOURCE_FILE, true),
  deleteMiscFiles: parseEnvBoolean(process.env.DELETE_MISC_FILES, true),
  videoShowProgress: parseEnvBoolean(process.env.VIDEO_SHOW_PROGRESS, true),
  videoSkipReencode: parseEnvBoolean(process.env.VIDEO_SKIP_REENCODE, true),
  folderCleanDepth: parseEnvInt(process.env.FOLDER_CLEAN_DEPTH, 1),
  videoSampleSeconds: parseEnvInt(process.env.VIDEO_SAMPLE_SECONDS, 300),
};

// Processing queue and state
const queue = [];
let processing = false;

// Recursive function to change permissions
async function chmodRecursive(dirPath, mode = 0o777) {
  try {
    const stats = await fs.stat(dirPath);
    await fs.chmod(dirPath, mode);
    if (stats.isDirectory()) {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);
        await chmodRecursive(entryPath, mode);
      }
    }
  } catch (err) {
    console.error(`Error changing permissions for '${dirPath}':`, err.message);
  }
}

// Recursive function to remove empty directories
async function removeEmptyDirectories(dirPath, depth = 0) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    let isEmpty = true;

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        await removeEmptyDirectories(entryPath, depth + 1);
        const subEntries = await fs.readdir(entryPath);
        if (subEntries.length === 0 && depth >= config.folderCleanDepth) {
          await fs.rmdir(entryPath);
          console.log(`Removed empty directory: ${entryPath}`);
        } else {
          isEmpty = false;
        }
      } else {
        isEmpty = false;
      }
    }

    if (isEmpty && depth >= config.folderCleanDepth) {
      await fs.rmdir(dirPath);
      console.log(`Removed empty directory: ${dirPath}`);
    }
  } catch (err) {
    console.error(`Error processing directory ${dirPath}: ${err.message}`);
  }
}

// Promisified ffprobe
function ffprobeAsync(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });
}

// Check if the file is in the target codec
async function isTargetCodec(filePath) {
  try {
    const metadata = await ffprobeAsync(filePath);
    const videoStream = metadata.streams.find(s => s.codec_type === 'video');
    if (videoStream) {
      const videoCodec = videoStream.codec_name.toLowerCase();
      console.log(`Video Codec: ${videoCodec}`);
      if (config.videoCodec.includes(videoCodec)) {
        return true;
      }
    }
    return false;
  } catch (err) {
    console.error('Error reading metadata:', err.message);
    return false;
  }
}

// Detect if the video is a sample
async function detectSample(filePath) {
  try {
    const metadata = await ffprobeAsync(filePath);
    const { format } = metadata;
    if (config.videoSampleSeconds > format.duration) {
      console.log(`'${filePath}' is shorter than ${config.videoSampleSeconds} seconds; treating as sample`);
      return true;
    }
    console.log(`'${filePath}' is a valid video file`);
    return false;
  } catch (err) {
    console.error('Error reading metadata:', err.message);
    return false;
  }
}

// Cleanup function to remove empty directories
async function cleanup() {
  if (config.folderCleanDepth >= 0) {
    await removeEmptyDirectories(config.watchDir);
    await removeEmptyDirectories(config.tempDir);
  }
}

// Process the queue of files
async function processQueue() {
  if (processing || queue.length === 0) return;

  processing = true;

  while (queue.length > 0) {
    const filepath = queue.shift();
    try {
      await processFile(filepath);
    } catch (err) {
      console.error(`Error processing file '${filepath}':`, err.message);
    }
  }

  processing = false;
}

// Add a file to the processing queue
function addToQueue(filepath) {
  queue.push(filepath);
  processQueue();
}

// Get ffmpeg command based on configuration
function getFfmpegCommand(inputPath, outputPath) {
  let command = ffmpeg(inputPath);

  const videoCodec = config.videoCodec;
  const videoBitRate = config.videoBitRate;

  switch (config.videoAccelApi) {
    case 'qsv':
      console.log('Using QuickSync to encode this file.');
      command
        .inputOptions([
          '-hwaccel_device', config.workDevice,
          '-hwaccel_output_format', 'qsv'
        ])
        .outputOptions([
          '-c:v', `${videoCodec}_qsv`,
          '-global_quality', videoBitRate,
          '-gpu_copy', 'on',
          '-c:a', 'copy',
          '-c:s', 'copy'
        ]);
      break;
    case 'va':
      console.log('Using VA-API to encode this file.');
      command
        .inputOptions([
          '-hwaccel', 'vaapi',
          '-hwaccel_device', config.workDevice,
          '-hwaccel_output_format', 'vaapi'
        ])
        .outputOptions([
          '-vf', 'format=nv12|vaapi,hwupload',
          '-c:v', `${videoCodec}_vaapi`,
          '-b:v', videoBitRate,
          '-c:a', 'copy',
          '-c:s', 'copy'
        ]);
      break;
    case 'nvenc':
      console.log('Using NVENC to encode this file.');
      command
        .inputOptions([
          '-hwaccel', 'nvdec'
        ])
        .outputOptions([
          '-c:v', `${videoCodec}_nvenc`,
          '-b:v', videoBitRate,
          '-c:a', 'copy',
          '-c:s', 'copy'
        ]);
      break;
    case 'vulkan':
      console.log('Using Vulkan to encode this file.');
      command
        .inputOptions([
          '-hwaccel', 'vulkan',
          '-init_hw_device', config.workDevice,
          '-hwaccel_output_format', 'vulkan'
        ])
        .outputOptions([
          '-vf', 'format=nv12,hwupload,vulkan',
          '-c:v', videoCodec,
          '-b:v', videoBitRate,
          '-c:a', 'copy',
          '-c:s', 'copy'
        ]);
      break;
    default:
      console.log('Using CPU to encode this file.');
      command
        .outputOptions([
          '-c:v', videoCodec,
          '-b:v', videoBitRate,
          '-c:a', 'copy',
          '-c:s', 'copy'
        ]);
      break;
  }

  command.output(outputPath);
  return command;
}

// Process a single file
async function processFile(filepath) {
  const newpath = filepath.replace(config.watchDir, config.completeDir);
  const temppath = filepath.replace(config.watchDir, config.tempDir);

  console.log(`Processing '${filepath}'`);

  await fs.mkdir(path.dirname(newpath), { recursive: true });
  await fs.mkdir(path.dirname(temppath), { recursive: true });

  let command = getFfmpegCommand(filepath, temppath);

  return new Promise((resolve, reject) => {
    command.on('end', async () => {
      console.log(`Processing finished for '${filepath}'`);
      try {
        await fs.copyFile(temppath, newpath);
        await fs.unlink(temppath);
        console.log(`Moved file '${temppath}' to '${newpath}'`);
        if (config.deleteSourceFile) {
          await fs.unlink(filepath);
          console.log(`Deleted source file '${filepath}'`);
        }
      } catch (err) {
        console.error(`Error handling files: ${err.message}`);
      }
      cleanup();
      resolve();
    })
    .on('error', err => {
      console.error('Error during processing:', err.message);
      queue.push(filepath);
      reject(err);
    })
    .on('progress', progress => {
      if (config.videoShowProgress)
        console.log(`Processing: ${progress.percent}% done at ${progress.currentFps} fps`);
    });

    command.run();
  });
}

// Check if the file is a work file
function isWorkFile(filepath) {
  return filepath.includes('/.') || filepath.includes('.queued') || filepath.includes('_UNPACK_');
}

// Check if the extension is a video file
function isVideoFile(extension) {
  return videoExtensions.includes(extension);
}

// Check if the extension is a subtitle file
function isSubtitleFile(extension) {
  return subtitleExtensions.includes(extension);
}

// Handle file addition
async function handleFileAdd(filepath) {
  try {
    if (isWorkFile(filepath)) {
      console.log(`Ignoring '${filepath}' because it is a work file`);
      return;
    }

    const extension = path.extname(filepath).toLowerCase();
    await chmodRecursive(filepath);

    const newpath = filepath.replace(config.watchDir, config.completeDir);
    await fs.mkdir(path.dirname(newpath), { recursive: true });

    if (isVideoFile(extension)) {
      console.log(`'${filepath}' looks like a video file`);

      if (await detectSample(filepath)) {
        console.log(`Ignoring '${filepath}' because it looks like a sample file`);
        return;
      }

      if (config.videoSkipReencode && await isTargetCodec(filepath)) {
        try {
          await fs.copyFile(filepath, newpath);
          await fs.unlink(filepath);
          console.log(`Moved '${filepath}' to '${newpath}' because it's already in the target codec`);
        } catch (err) {
          console.error(`Error handling file '${filepath}':`, err.message);
        }
        return;
      }

      addToQueue(filepath);
    } else if (isSubtitleFile(extension)) {
      try {
        await fs.copyFile(filepath, newpath);
        await fs.unlink(filepath);
        console.log(`Moved subtitle file '${filepath}' to '${newpath}'`);
      } catch (err) {
        console.error(`Error handling file '${filepath}':`, err.message);
      }
    } else if (config.deleteMiscFiles) {
      try {
        await fs.unlink(filepath);
        console.log(`Removed '${filepath}' because it was of unknown type and deleteMiscFiles was set`);
      } catch (err) {
        console.error(`Error handling file '${filepath}':`, err.message);
      }
    }
  } catch (err) {
    console.error(`Error processing file '${filepath}':`, err.message);
  }
}

// Initial cleanup
cleanup();

// Start watching the watch directory
chokidar
  .watch(config.watchDir, {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: true,
    ignored: '(?<![^/])\\.',
    depth: 99
  })
  .on('add', handleFileAdd);
