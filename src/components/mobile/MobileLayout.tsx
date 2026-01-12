import React, { ReactNode } from 'react';
import MobileTransportBar from './MobileTransportBar';
import MobileBottomNav from '../MobileBottomNav';
import MobileFloatingActions from './MobileFloatingActions';
import { MobileTab, TrackType, PluginType } from '../../types';

interface MobileLayoutProps {
  children: ReactNode;
  
  // Transport props
  isPlaying: boolean;
  isRecording: boolean;
  currentTime: number;
  onTogglePlay: () => void;
  onStop: () => void;
  onToggleRecord: () => void;
  
  // Navigation props
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
  
  // FAB props
  onCreateTrack: (type: TrackType, name?: string, initialPluginType?: PluginType) => void;
  
  // Optional
  showTransport?: boolean;
  showBottomNav?: boolean;
  showFAB?: boolean;
  onOpenSettings?: () => void;
}

/**
 * Mobile layout wrapper component
 * Provides consistent mobile UI structure:
 * - Mini transport bar at top
 * - Main content in middle
 * - FAB for quick actions
 * - Bottom navigation
 */
const MobileLayout: React.FC<MobileLayoutProps> = ({
  children,
  isPlaying,
  isRecording,
  currentTime,
  onTogglePlay,
  onStop,
  onToggleRecord,
  activeTab,
  onTabChange,
  onCreateTrack,
  showTransport = true,
  showBottomNav = true,
  showFAB = true,
  onOpenSettings,
}) => {
  return (
    <div className="flex flex-col h-screen w-full overflow-hidden bg-[#0c0d10]">
      {/* Mini Transport Bar */}
      {showTransport && (
        <MobileTransportBar
          isPlaying={isPlaying}
          isRecording={isRecording}
          currentTime={currentTime}
          onTogglePlay={onTogglePlay}
          onStop={onStop}
          onToggleRecord={onToggleRecord}
          onOpenSettings={onOpenSettings}
        />
      )}

      {/* Main Content Area */}
      <div className="flex-1 overflow-hidden relative">
        {children}
      </div>

      {/* Floating Action Button */}
      {showFAB && activeTab !== 'SETTINGS' && (
        <MobileFloatingActions
          onCreateTrack={onCreateTrack}
          onToggleRecord={onToggleRecord}
          isRecording={isRecording}
        />
      )}

      {/* Bottom Navigation */}
      {showBottomNav && (
        <MobileBottomNav activeTab={activeTab} onTabChange={onTabChange} />
      )}
    </div>
  );
};

export default MobileLayout;
