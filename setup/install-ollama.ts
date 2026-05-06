import { spawnSync } from 'child_process';
import * as p from '@clack/prompts';
import { runInheritScript } from './lib/runner.js';
import { brandBody, dimWrap } from './lib/theme.js';

export async function runOllamaStep(model: string): Promise<boolean> {
  const isInstalled = checkOllamaInstalled();

  if (!isInstalled) {
    p.log.message(brandBody(dimWrap('Ollama is not installed. NanoClaw needs it to run local models.', 4)));
    
    const s = p.spinner();
    s.start('Installing Ollama... (this may ask for your password)');
    
    // We run the official installer script
    const res = spawnSync('curl', ['-fsSL', 'https://ollama.com/install.sh'], { encoding: 'utf-8' });
    if (res.status === 0) {
      const installRes = spawnSync('sh', ['-c', res.stdout], { stdio: 'inherit' });
      if (installRes.status !== 0) {
        s.stop('Failed to install Ollama.', 1);
        return false;
      }
    } else {
      s.stop('Failed to download Ollama installer.', 1);
      return false;
    }
    
    s.stop('Ollama installed successfully.');
  }

  p.log.step(`Pulling the ${model} model. This is a large download (~8GB) and may take a while depending on your connection.`);
  const pullRes = await runInheritScript('ollama', ['pull', model]);
  
  if (pullRes !== 0) {
    p.log.error(`Failed to pull ${model}. You can try manually later with: ollama pull ${model}`);
    return false;
  }
  
  p.log.success(`${model} downloaded and ready.`);
  return true;
}

function checkOllamaInstalled(): boolean {
  try {
    const res = spawnSync('ollama', ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return res.status === 0;
  } catch {
    return false;
  }
}

function runInheritScript(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawnSync(cmd, args, { stdio: 'inherit' });
    resolve(child.status ?? 1);
  });
}
