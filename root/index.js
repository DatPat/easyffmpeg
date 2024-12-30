// Import required modules
const chokidar = require('chokidar');
const fs = require('fs').promises;
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const seven = require('node-7z');
const { Console } = require('console');
var http    = require("http");

// Supported file extensions
const videoExtensions = ['.mp4', '.mkv', '.m4v', '.avi', '.m4x', '.mpeg', '.mpg', '.divx', '.wmv', '.mov', '.webm'];
const subtitleExtensions = ['.srt', '.ass', '.sub', '.ssa', '.smi', '.vtt'];
const archiveExtensions = ['.zip', '.rar', '.7z', '.gz', '.tar', '.z', '.000', '.001', '.lz', '.xz', '.bz2'];
const throttledshowProgress = throttle(showProgress, 5000);

var logbuffer = "";

process.stdout.write = (function(write) {
  return function(string, encoding, fd) {
    logbuffer += string;
    write.apply(process.stdout, arguments); // Also output to stdout
  };
})(process.stdout.write);

var app = http.createServer(function (req, res) {
  res.writeHead(200, {"Content-Type": "text/plain"});
  res.end(logbuffer);
});

app.listen(1337);

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
  watchDir: process.env.WATCH_DIR || '/work/complete',
  tempDir: process.env.TEMP_DIR || '/work/incomplete',
  completeDir: process.env.COMPLETE_DIR || '/work/ready',
  workDir: process.env.WORK_DIR || '/work',

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
  consoleColorTags: parseEnvBoolean(process.env.CONSOLE_COLOR_TAGS, true),
};

if (config.consoleColorTags) {
  var reset = "\x1b[0m";      // Reset the color
  var red = "\x1b[31m";       // Red color
  var green = "\x1b[32m";     // Green color
  var yellow = "\x1b[33m";    // Yellow color
  var blue = "\x1b[34m";      // Blue color
} else {
  var reset = "";      // Reset the color
  var red = "";       // Red color
  var green = "";     // Green color
  var yellow = "";    // Yellow color
  var blue = "";      // Blue color  
}

// Processing queue and state
const queue = [];
let processing = false;

function throttle(func, delay) {
  let lastCall = 0;

  return function(...args) {
      const now = Date.now();

      if (now - lastCall >= delay) {
          lastCall = now;
          return func(...args);
      }
  };
}

function deleteNumberedFiles(filePath) {
  try {
      // Extract the directory and base name from the file path
      const dir = path.dirname(filePath);
      const baseName = path.basename(filePath, path.extname(filePath)); // Remove .000, .001, etc.

      // Read all files in the directory
      fs.readdir(dir, (err, files) => {
          if (err) {
              throw new Error(`Error reading directory: ${err.message}`);
          }
          files.forEach(file => {
              if (isSplitArchive(file)) {
                  const fullPath = path.join(dir, file);
                  fs.unlink(fullPath, err => {
                      if (err) {
                          throw new Error(`Error deleting file: ${err.message}`);
                      } else {
                          console.log(`Deleted: ${fullPath}`);
                      }
                  });
              }
          });
      });
  } catch (err) {
      console.log(`Operation failed: ${err.message}`);
  }
}

function isSplitArchive(filePath) {
  // Extract the extension from the file path
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath);
  
  // Define the patterns for different split archive extensions
  const splitExtensions = [
      /\.7z\.\d{3}$/i,           // 7-Zip split files: .7z.001, .7z.002, etc.
      /\.part\d+\.rar$/i,        // RAR split files (new): .part1.rar, .part2.rar, etc.
      /\.r\d{2}$/i,              // RAR split files (old): .r00, .r01, etc.
      /\.z\d{2}$/i,              // ZIP split files: .z01, .z02, etc.
      /\.tar\.part\d+$/i,        // TAR split files: .tar.part1, .tar.part2, etc.
      /\.iso\.\d{3}$/i,          // ISO split files: .iso.001, .iso.002, etc.
      /\.gz\.\d{3}$/i,           // GZIP split files: .gz.001, .gz.002, etc.
      /\.bz2\.\d{3}$/i,          // BZIP2 split files: .bz2.001, .bz2.002, etc.
      /\.xz\.\d{3}$/i,           // XZ split files: .xz.001, .xz.002, etc.
      /\.c\d{2}$/i               // ACE split files: .c00, .c01, etc.
  ];

  // Check if the file matches any of the known split archive patterns
  return splitExtensions.some(regex => regex.test(baseName));
}

function showProgress(percentage, fps) {
  if (isNaN(percentage) || percentage < 0) {
    if (fps > 0)
      console.log(`Processing: ${yellow}[${fps}fps]${reset}`);
    else
      console.log('Processing...');
  } else {
    const barLength = 40; // Total length of the progress bar (in characters)
    const completedLength = Math.round((percentage / 100) * barLength); // Calculate completed part of the bar
    if (config.consoleColorTags) {
      var progressBar = '█'.repeat(completedLength) + '-'.repeat(barLength - completedLength); // Create the bar
    } else {
      var progressBar = '+'.repeat(completedLength) + '-'.repeat(barLength - completedLength); // Create the bar
    }
    if (fps > 0) {
      console.log(`${green}[${progressBar}] ${percentage.toFixed(2)}% @ ${yellow}${fps}fps${reset}`);
    } else {
      console.log(`${blue}[${progressBar}] ${percentage.toFixed(2)}%${reset}`);
    }
  }
}

async function moveContents(srcDir, destDir) {
  try {
    // Check if source exists
    await fs.access(srcDir);

    // Ensure the destination directory exists, if not create it
    try {
      await fs.mkdir(destDir, { recursive: true });
    } catch (error) {
      console.log('mkdir failed.');
    }

    try {
      // Read the contents of the source directory
      const items = await fs.readdir(srcDir);

      // Loop through each item in the source directory
      for (const item of items) {
        const srcPath = path.join(srcDir, item);
        const destPath = path.join(destDir, item);

        // Check if item is a file or directory
        const stats = await fs.stat(srcPath);
        if (stats.isDirectory()) {
          // Recursively move the directory contents
          await moveContents(srcPath, destPath);
          // Remove the empty source directory
          await fs.rmdir(srcPath);
        } else if (stats.isFile()) {
          // Move the file to the destination
          await fs.rename(srcPath, destPath);
        }
      }
    } catch (error) {
      console.log(`Contents moved from "${srcDir}" to "${destDir}" successfully.`);
    }
    
  } catch (error) {
    console.log(`Error moving contents: ${error.message}`);
  }
}

async function extractArchive(archivePath, destPath) {
  console.log(`Extracting ${archivePath} to ${destPath}`);

  const temppath = destPath.replace(config.watchDir, config.tempDir);

  return new Promise((resolve, reject) => {
    try {
      const extract = seven.extractFull(archivePath, temppath, {
        $progress: true,
        $recursive: true
      });
      
      extract.on('progress', (progress) => {
        throttledshowProgress(progress.percent, 0);
      });
      
      extract.on('end', async () => {
        console.log(`Extraction complete to ${destPath}`);
        try {
          chmodRecursive(temppath);
        } catch (err) {
          console.log('Couldn\'t chmod: ' + archivePath + ' Error: ' + err);
        }
        if (config.deleteSourceFile) {
          try {
            //await fs.rm(archivePath);
            console.log('File: ' + archivePath + ' deleted because deleteSourceFile was set');
          } catch (err) {
            console.log('Couldn\'t delete: ' + archivePath + ' Error: ' + err);
          }
          //deleteNumberedFiles(filepath);
        }

        try {
          console.log(`moving from ${temppath} to ${destPath}`);
          await moveContents(temppath, destPath);
        } catch (error) {
          console.log('Error moving contents:', error.message);
        }
        resolve();  // Resolve the promise when extraction is done
      });
      
      extract.on('error', (err) => {
        console.log('Extraction failed:', err);
        reject(err);  // Reject the promise on error
      });
      
    } catch (err) {
      console.log('Exception during extraction:', err);
      reject(err);  // Catch any synchronous errors
    }
  });
}

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
    console.log(`${red} Error changing permissions for '${dirPath}': ${err.message}${reset}`);
  }
}

// Watch for new files in the WATCH_DIR
async function removeEmptyDirectories(dirPath, depth = 0) {
  //  console.error(`cleaning ${dirPath}`);
    try {
        // Get list of directory entries with types (files/directories)
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
  
        // Traverse through the directory contents
        for (const entry of entries) {
            const entryPath = path.join(dirPath, entry.name);
  
            // If it's a directory, recurse into it
            if (entry.isDirectory()) {
                // Recursively remove empty directories, increasing depth
                await removeEmptyDirectories(entryPath, depth + 1);
  
                // After recursion, check if the directory is now empty
                const isEmpty = (await fs.readdir(entryPath)).length === 0;
                if (isEmpty && depth >= config.folderCleanDepth) {
                    // If the directory is empty and not at the first level, remove it
                    await fs.rmdir(entryPath);
                 //   console.log(`Removed empty directory: ${entryPath} E:${isEmpty} D:${depth}`);
                } else {
                //  console.log(`Keeping directory: ${entryPath} E:${isEmpty} D:${depth}`);
                }
            }
        }
    } catch (err) {
        console.log(`${red}Error processing directory ${dirPath}: ${err.message}${reset}`);
    }
  //  console.error(`cleaned ${dirPath}`);
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
    console.log(`${red}Error reading metadata: ${err.message}${reset}`);
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
    console.log(`${red}Error reading metadata:${err.message}${reset}`);
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
      console.log(`${red}Error processing file '${filepath}':${err.message}${reset}`);
    }
  }
  cleanup();
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
      case 'amf':
        console.log('Using AMF to encode this file.');
        command
          .outputOptions([
            '-c:v', `${videoCodec}_amf`,
            '-b:v', videoBitRate,
            '-c:a', 'copy',
            '-c:s', 'copy'
          ]);
        break;
    case 'qsvo':
      console.log('Using QuickSync Optimized to encode this file.');
      command
        .inputOptions([
          '-hwaccel_device', config.workDevice,
          '-hwaccel_output_format', 'qsv'
        ])
        .outputOptions([
          '-c:v', `${videoCodec}_qsv`,
          '-preset', 'veryslow',
          '-extbrc', '0',
          '-look_ahead_depth', '40',
          '-b:v', videoBitRate,
          '-bufsize', '2M',
          '-rc_init_occupancy', '512K',
          '-low_power', '0',
          '-adaptive_i', '1',
          '-adaptive_b', '1',
          '-b_strategy', '1', '-bf', '7',
       //   '-gpu_copy', 'on',
          '-c:a', 'copy',
          '-c:s', 'copy'
        ]);
      /*
      ffmpeg \
  -i input.mp4 \
  -init_hw_device vaapi=va:/dev/dri/renderD128 \
  -c:v av1_qsv \
  -preset veryslow \
  -extbrc 1 \
  -look_ahead_depth 40 \
  -b:v 1M \
  -bufsize 2M \
  -rc_init_occupancy 512K \
  -low_power 0 \
  -adaptive_i 1 \
  -adaptive_b 1 \
  -b_strategy 1 -bf 7 \
  output.mp4
  */
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
    case 'libsvtav1':
      console.log('Using libsvtav1 to encode this file.');
      //ffmpeg -i "INPUT.mp4" -pix_fmt yuv420p10le -c:v libsvtav1
      //-preset 4 -crf 18 -g 240 -svtav1-params tune=0:enable-variance-boost=1:enable-qm=1 -c:a copy "OUTPUT.mp4"
      command
      .outputOptions([
        '-vf', 'format=nv12,hwupload,vulkan',
        '-c:v', 'libsvtav1',
        '-crf', videoBitRate,
        '-g', '240',
        '-svtav1-params', `tune=0:enable-variance-boost=1:enable-qm=1`,
        '-c:a', 'copy',
        '-c:s', 'copy'
      ]);
      break;
      case 'libaom':
        console.log('Using libaom to encode this file.');
        //ffmpeg -i input.mp4 -c:v libaom-av1 -cpu-used 4 -b:v 0 -crf 28 -g 240 -keyint_min 120 -tile-columns 2 -tile-rows 2 -threads 8 -c:a copy output.mkv
        command
        .outputOptions([
          '-vf', 'format=nv12,hwupload,vulkan',
          '-c:v', 'libaom-av1',
          '-cpu-used', '4',
          '-b:v', '0',
          '-crf', videoBitRate,
          '-g', '240',
          '-keyint_min', '120',
          '-tile-columns', '2',
          '-tile-rows', '2',
          '-threads', '8',
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

function removeFileExtension(filePath) {
  const parsedPath = path.parse(filePath);
  return path.format({
    ...parsedPath,
    base: parsedPath.name, // This removes the extension by setting base to name
    ext: '' // Set ext to an empty string
  });
}


// Process a single file
async function processFile(filepath) {
  const newpath = filepath.replace(config.watchDir, config.completeDir);
  const temppath = filepath.replace(config.watchDir, config.tempDir);
  const ext = path.extname(filepath);

  console.log(`Processing '${filepath}'`);

  if (isArchive(ext)) {
    try {
      const extractionPath = removeFileExtension(filepath);
      fs.mkdir(extractionPath, {recursive: true});
      console.log(ext + ' extraction to ' + extractionPath);
      await extractArchive(filepath, extractionPath);
    } catch (err) {
      console.log(`${red}Error extracting file '${filepath}' ${err.message}${reset}`);
    }
    //console.log("---all done---");
    return;
  }

  await fs.mkdir(path.dirname(newpath), { recursive: true });
  await fs.mkdir(path.dirname(temppath), { recursive: true });

  let command = getFfmpegCommand(filepath, temppath);

  return new Promise((resolve, reject) => {
    command.on('end', async () => {
      console.log(`Processing finished for '${filepath}'`);
      try {
        await fs.rename(temppath, newpath);
     //   await fs.unlink(temppath);
        console.log(`${yellow}Moved file '${temppath}' to '${newpath}'${reset}`);
        if (config.deleteSourceFile) {
          await fs.unlink(filepath);
          console.log(`${yellow}Deleted source file '${filepath}'${reset}`);
        }
      } catch (err) {
        console.log(`${red}Error handling files: ${err.message}${reset}`);
      }
      resolve();
    })
    .on('error', err => {
      console.log(`${red}Error during processing:${err.message}${reset}`);
      reject(err);
    })
    .on('progress', progress => {
      if (config.videoShowProgress)
        throttledshowProgress(progress.percent,progress.currentFps);
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

// Check if the extension is a an extractable file
function isArchive(extension) {
  return archiveExtensions.includes(extension);
}

// Handle file addition
async function handleFileAdd(filepath) {
  try {
    console.log('detected ' + filepath);

    if (isWorkFile(filepath)) {
      console.log(`${yellow}Ignoring '${filepath}' because it is a work file${reset}`);
      return;
    }

    const extension = path.extname(filepath).toLowerCase();
    await chmodRecursive(filepath);

    const newpath = filepath.replace(config.watchDir, config.completeDir);
    await fs.mkdir(path.dirname(newpath), { recursive: true });

    if (isVideoFile(extension)) {
      console.log(`'${filepath}' looks like a video file`);

      if (await detectSample(filepath)) {
        if (config.deleteMiscFiles) {
          try {
            await fs.unlink(filepath);
            console.log(`${yellow}Removed '${filepath}' because it was a sample and deleteMiscFiles was set${reset}`);
          } catch (err) {
            console.log(`${red}Error purging file '${filepath}':${err.message} ${reset}`);
          }
        } else {
          console.log(`${yellow}Ignoring '${filepath}' because it looks like a sample file${reset}`);
        }
        return;
      }

      if (config.videoSkipReencode && await isTargetCodec(filepath)) {
        try {
          await fs.rename(filepath, newpath);
          //await fs.unlink(filepath);
          console.log(`${yellow}Moved '${filepath}' to '${newpath}' because it's already in the target codec${reset}`);
        } catch (err) {
          console.log(`${red}Error handling file '${filepath}':${err.message}${reset}`);
        }
        return;
      }
      addToQueue(filepath);
    } else if (isSubtitleFile(extension)) {
      try {
        await fs.rename(filepath, newpath);
        //await fs.unlink(filepath);
        console.log(`${yellow}Moved subtitle file '${filepath}' to '${newpath}'${reset}`);
      } catch (err) {
        console.log(`${red}Error copying subtitle file '${filepath}':${err.message}${reset}`);
      }
    } else if (isArchive(extension)) {
        //addToQueue(filepath);
        console.log('ignoring archive: ', filepath);
    } else if (config.deleteMiscFiles && isSplitArchive(filepath) === false) {
      try {
        await fs.unlink(filepath);
        console.log(`${red}Removed '${filepath}' because it was of unknown type and deleteMiscFiles was set${reset}`);
      } catch (err) {
        console.log(`${red}Error purging file '${filepath}' ${err.message}${reset}`);
      }
    }
  } catch (err) {
    console.log(`${red}Error processing file '${filepath}':${err.message}${reset}`);
  }
}

function tryHandleFileAdd(filepath)
{
  try {
    handleFileAdd(filepath);
  } catch (err) {
    console.log(`${red}Error processing file '${filepath}':${err.message}${reset}`);
  }
}

// Initial cleanup
cleanup();

console.log(`Watching directory: ${config.watchDir}`);
console.log(`Using temp directory: ${config.tempDir}`);
console.log(`Using complete directory: ${config.completeDir}`);

// Start watching the watch directory
try {
chokidar
  .watch(config.watchDir, {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: true,
    ignored: '(?<![^/])\\.',
    depth: 99
  })
  .on('add', tryHandleFileAdd);
} catch (err) {
  console.log(`${red}Error processing file '${filepath}':${err.message}${reset}`);
}