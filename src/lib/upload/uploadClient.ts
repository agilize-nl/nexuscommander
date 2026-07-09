const API = "/api";

export interface PreflightFile {
  rel: string;
  size: number;
}

export interface PreflightConflict {
  rel: string;
  is_dir: boolean;
  size: number;
  modified: number;
}

export interface PreflightResult {
  free: number | null;
  needed: number;
  conflicts: PreflightConflict[];
  invalid: string[];
}

export async function preflightUpload(dir: string, files: PreflightFile[], dirs: string[] = []): Promise<PreflightResult> {
  const url = `${API}/upload/preflight`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ dir, files, dirs }),
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {}
    throw new Error(`Upload preflight failed: ${message}`);
  }
  return response.json();
}

export interface UploadFileOptions {
  overwrite: boolean;
  onProgress: (sent: number) => void;
}

export interface UploadHandle {
  promise: Promise<void>;
  abort: () => void;
}

export function uploadOneFile(
  dir: string,
  rel: string,
  file: File,
  opts: UploadFileOptions
): UploadHandle {
  const xhr = new XMLHttpRequest();
  
  const query = new URLSearchParams({
    dir,
    rel,
    size: String(file.size),
    mtime: String(file.lastModified),
    overwrite: opts.overwrite ? '1' : '0'
  });
  
  const url = `${API}/upload/file?${query.toString()}`;
  
  const promise = new Promise<void>((resolve, reject) => {
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        opts.onProgress(e.loaded);
      }
    };
    
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        let message = `Upload failed with status ${xhr.status}`;
        try {
          const body = JSON.parse(xhr.responseText);
          if (body?.error) message = body.error;
        } catch {}
        
        const err = new Error(message) as any;
        err.status = xhr.status;
        reject(err);
      }
    };
    
    xhr.onerror = () => {
      reject(new Error('Network error during upload'));
    };
    
    xhr.onabort = () => {
      reject(new Error('Upload aborted'));
    };
    
    xhr.open('PUT', url, true);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.send(file);
  });
  
  return {
    promise,
    abort: () => xhr.abort()
  };
}
