const chokidar = require('chokidar');
const fs = require('fs').promises;
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

const {
    WATCH_DIR = '/watch', // place to look for new video files
    TEMP_DIR = '/temp', // scratch buffer for ffmpeg, location of converting files
    COMPLETE_DIR = '/ready', // where should the converted video files be moved to?
    WORK_DEVICE = '/dev/dri/renderD128', // device to be used to do the work set to "vulkan=vk:0" for vulkan
    VIDEO_BIT_RATE = '4M', // bitrate or quality index for qsv e.g 25
    VIDEO_CODEC = 'av1', // the codec or library when doing cpu transcode
    DELETE_SOURCE_FILE = '1', // remove the original file after conversion?
    DELETE_MISC_FILES = '1', // delete non-video and non subtitle files?
    VIDEO_ACCEL_API = 'va', // acceleration api to be used: va,qsv,nvenc or vulkan
    VIDEO_SHOW_PROGRESS = '1'
  } = process.env;

const queue = []
const deleteSourceFile = DELETE_SOURCE_FILE === '1';
const deleteMiscFiles = DELETE_MISC_FILES === '1';
const videoShowProgresss = VIDEO_SHOW_PROGRESS === '1';

let working = false

// Watch for new files in the WATCH_DIR
console.log(`[+] Watching '${WATCH_DIR}' for new video files`);

function deleteEmptySubfolders(directory) {
    // Get the immediate subdirectories of the given directory
    
    const firstLevelDirs = fs.readdirSync(directory).map(name => path.join(directory, name)).filter(source => fs.lstatSync(source).isDirectory());

    // Function to recursively delete empty folders
    function deleteEmptyFolders(dir) {
        // Get all items in the directory
        const files = fs.readdirSync(dir);

        // Recursively delete subfolders
        files.forEach(file => {
            const fullPath = path.join(dir, file);
            if (fs.lstatSync(fullPath).isDirectory()) {
                deleteEmptyFolders(fullPath);
            }
        });

        // After deleting subfolders, check if the directory is empty
        if (fs.readdirSync(dir).length === 0 && !firstLevelDirs.includes(dir)) {
            fs.rmdirSync(dir);
            console.log(`Deleted empty folder: ${dir}`);
        }
    }

    // Start the deletion process for each first-level directory
    firstLevelDirs.forEach(subdir => {
        const subSubDirs = fs.readdirSync(subdir).map(name => path.join(subdir, name)).filter(source => fs.lstatSync(source).isDirectory());

        subSubDirs.forEach(deleteEmptyFolders);
    });
}

function cleanup() {
  deleteEmptySubfolders(WATCH_DIR)
  deleteEmptySubfolders(TEMP_DIR)
}

setInterval(() => {
  if (working)
    return;

  const filepath = queue.shift();

  if (typeof filepath === 'undefined')
    return;

  working = true;

  const newpath = filepath.replace(WATCH_DIR, COMPLETE_DIR);
  const temppath = filepath.replace(WATCH_DIR, TEMP_DIR);

  console.log(`Converting '${filepath}'`);
  
  if (VIDEO_ACCEL_API == 'qsv') {
    ffmpeg(filepath)
    .inputOptions([
      '-hwaccel', 'qsv',
      '-hwaccel_device', WORK_DEVICE,
    ])
    .outputOptions([
      '-c:v', VIDEO_CODEC + '_qsv',
      '-global_quality', VIDEO_BIT_RATE,
      '-c:a', 'copy',
      '-c:s', 'copy'
    ])
    .output(temppath)
    .on('end', async () => {
      console.log(`Processing finished for '${filepath}'`);
      if (deleteSourceFile) {
        try {
          await fs.copyFile(temppath, newpath)
          await fs.unlink(temppath);
          console.log(`Moved file '${temppath}' to file '${newpath}'`);
          await fs.unlink(filepath);
          console.log(`Deleted source file '${filepath}'`);
        } catch (err) {
          console.error(`Error deleting source file '${filepath}':`, err.message);
          working = false;
        }
      }
      working = false;
    })
    .on('error', err => {
      console.error('Error during processing:', err.message);
      working = false;
    })
    .on('progress', (progress) => {
      if (videoShowProgresss)
        console.log('Processing: ' + progress.percent + '% done at ' + progress.currentFps + ' fps');
    })
    .run();
  } else if (VIDEO_ACCEL_API == 'va') {
    ffmpeg(filepath)
    .inputOptions([
      '-hwaccel', 'vaapi',
      '-hwaccel_device', WORK_DEVICE,
      '-hwaccel_output_format', 'vaapi'
    ])
    .outputOptions([
      '-vf', 'format=nv12|vaapi,hwupload',
      '-c:v', VIDEO_CODEC + '_vaapi',
      '-b:v', VIDEO_BIT_RATE,
      '-c:a', 'copy',
      '-c:s', 'copy'
    ])
    .output(temppath)
    .on('end', async () => {
      console.log(`Processing finished for '${filepath}'`);
      if (deleteSourceFile) {
        try {
          await fs.copyFile(temppath, newpath)
          await fs.unlink(temppath);
          console.log(`Moved file '${temppath}' to file '${newpath}'`);
          await fs.unlink(filepath);
          console.log(`Deleted source file '${filepath}'`);
        } catch (err) {
          console.error(`Error deleting source file '${filepath}':`, err.message);
          working = false;
        }
      }
      working = false;
    })
    .on('error', err => {
      console.error('Error during processing:', err.message);
      working = false;
    })
    .on('progress', (progress) => {
      if (videoShowProgresss)
        console.log('Processing: ' + progress.percent + '% done at ' + progress.currentFps + ' fps');
    })
    .run();
  } else if (VIDEO_ACCEL_API == 'nvenc') {
    ffmpeg(filepath)
    .inputOptions([
      '-hwaccel', 'nvdec'
    ])
    .outputOptions([
      '-c:v', VIDEO_CODEC + '_nvenc',
      '-b:v', VIDEO_BIT_RATE,
      '-c:a', 'copy',
      '-c:s', 'copy'
    ])
    .output(temppath)
    .on('end', async () => {
      console.log(`Processing finished for '${filepath}'`);
      if (deleteSourceFile) {
        try {
          await fs.copyFile(temppath, newpath)
          await fs.unlink(temppath);
          console.log(`Moved file '${temppath}' to file '${newpath}'`);
          await fs.unlink(filepath);
          console.log(`Deleted source file '${filepath}'`);
        } catch (err) {
          console.error(`Error deleting source file '${filepath}':`, err.message);
          working = false;
        }
      }
      working = false;
    })
    .on('error', err => {
      console.error('Error during processing:', err.message);
      working = false;
    })
    .on('progress', (progress) => {
      if (videoShowProgresss)
        console.log('Processing: ' + progress.percent + '% done at ' + progress.currentFps + ' fps');
    })
    .run();
  } else if (VIDEO_ACCEL_API == 'vulkan') {
/*docker run --rm -it \
  --device=/dev/dri:/dev/dri \
  -v $(pwd):/config \
  -e ANV_VIDEO_DECODE=1 \
  linuxserver/ffmpeg \
  -init_hw_device "vulkan=vk:0" \
  -hwaccel vulkan \
  -hwaccel_output_format vulkan \
  -i /config/input.mkv \
  -f null - -benchmark*/
    /* ffmpeg -hwaccel vulkan -i input.mp4 -vf "format=nv12,hwupload,vulkan" -c:v h264 output.mp4*/
  ffmpeg(filepath)
  .inputOptions([
    '-hwaccel', 'vulkan',
    '-init_hw_device', WORK_DEVICE,
    '-hwaccel_output_format', 'vulkan'
  ])
  .outputOptions([
    '-vf',  'format=nv12,hwupload,vulkan',
    '-c:v', VIDEO_CODEC,
    '-b:v', VIDEO_BIT_RATE,
    '-c:a', 'copy',
    '-c:s', 'copy'
  ])
  .output(temppath)
  .on('end', async () => {
    console.log(`Processing finished for '${filepath}'`);
    if (deleteSourceFile) {
      try {
        await fs.copyFile(temppath, newpath)
        await fs.unlink(temppath);
        console.log(`Moved file '${temppath}' to file '${newpath}'`);
        await fs.unlink(filepath);
        console.log(`Deleted source file '${filepath}'`);
      } catch (err) {
        console.error(`Error deleting source file '${filepath}':`, err.message);
        working = false;
      }
    }
    working = false;
  })
  .on('error', err => {
    console.error('Error during processing:', err.message);
    working = false;
  })
  .on('progress', (progress) => {
    if (videoShowProgresss)
      console.log('Processing: ' + progress.percent + '% done at ' + progress.currentFps + ' fps');
  })
  .run();
  } else { /* cpu transcode */
    ffmpeg(filepath)
    .outputOptions([
      '-c:v', VIDEO_CODEC,
      '-b:v', VIDEO_BIT_RATE,
      '-c:a', 'copy',
      '-c:s', 'copy'
    ])
    .output(temppath)
    .on('end', async () => {
      console.log(`Processing finished for '${filepath}'`);
      if (deleteSourceFile) {
        try {
          await fs.copyFile(temppath, newpath)
          await fs.unlink(temppath);
          console.log(`Moved file '${temppath}' to file '${newpath}'`);
          await fs.unlink(filepath);
          console.log(`Deleted source file '${filepath}'`);
        } catch (err) {
          console.error(`Error deleting source file '${filepath}':`, err.message);
          working = false;
        }
      }
      working = false;
    })
    .on('error', err => {
      console.error('Error during processing:', err.message);
      working = false;
    })
    .on('progress', (progress) => {
      if (videoShowProgresss)
        console.log('Processing: ' + progress.percent + '% done at ' + progress.currentFps + ' fps');
    })
    .run();
  }

}, 5000);

chokidar
  .watch(WATCH_DIR, {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: true,
    ignored: '(?<![^/])\\.',
    depth: 99
  })
  .on('add', async filepath => {
    const newpath = filepath.replace(WATCH_DIR, COMPLETE_DIR);
    const temppath = filepath.replace(WATCH_DIR, TEMP_DIR);
    await fs.mkdir(path.dirname(newpath), { recursive: true });
    await fs.mkdir(path.dirname(temppath), { recursive: true });
  
    const extension = path.extname(filepath);

    if (filepath.includes('/.') || filepath.includes('.queued')|| filepath.includes('_UNPACK_')) {
      console.log(`Ignoring '${filepath}' because it is a work file`);
      return;
    }

    if (['.mp4', '.mkv', '.m4v'].includes(extension)) {
      queue.push(filepath);
    } else if (['.srt', '.ass', '.sub', '.ssa', '.smi', '.vtt'].includes(extension)) {
      try {
          await fs.copyFile(filepath, newpath)
          await fs.unlink(filepath);
          console.log(`Moved '${filepath}' to '${newpath}'`);
      } catch (err) {
        console.error(`Error handling file '${filepath}':`, err.message);
      }
    } else if (deleteMiscFiles) {
      try {
        await fs.unlink(filepath);
        console.log(`Removed '${filepath}' because it was of unknown type and deletemiscfiles was set`);
      } catch (err) {
        console.error(`Error handling file '${filepath}':`, err.message);
      }
    }
  });
