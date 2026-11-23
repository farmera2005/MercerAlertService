'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui';
import { NocBoard } from './board';
import type { NocBoardView, NocData } from './types';

/** The /noc board with a full-screen button (larger text in full screen). */
export function NocDesktop({ board, data }: { board: NocBoardView; data: NocData }) {
  const frame = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === frame.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  return (
    <div>
      <div className="mb-2 flex justify-end">
        <Button
          type="button"
          variant="secondary"
          className="px-3 py-1 text-xs"
          onClick={() => void frame.current?.requestFullscreen?.()}
          data-testid="noc-fullscreen"
        >
          Full screen
        </Button>
      </div>
      <div
        ref={frame}
        className={
          full
            ? 'h-screen bg-[#0a0e13] p-2 text-slate-100 [&_[data-testid=noc-board]]:!text-[clamp(16px,2.3vh,28px)]'
            : 'lg:h-[calc(100vh-12rem)] lg:min-h-[640px]'
        }
      >
        <NocBoard board={board} data={data} mode="desktop" className={full ? 'h-full' : ''} />
      </div>
    </div>
  );
}
