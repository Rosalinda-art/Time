import React, { useState, useEffect } from 'react';
import { Clock, AlertTriangle, X } from 'lucide-react';
import { StudySession } from '../types';

interface SessionTimeEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  session: StudySession;
  planDate: string;
  onSave: (newStartTime: string) => void;
}

const SessionTimeEditModal: React.FC<SessionTimeEditModalProps> = ({
  isOpen,
  onClose,
  session,
  planDate,
  onSave
}) => {
  const [startTime, setStartTime] = useState(session.startTime);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setStartTime(session.startTime);
      setError(null);
    }
  }, [isOpen, session.startTime]);

  const handleSave = () => {
    // Validate that start time is before end time
    if (startTime >= session.endTime) {
      setError('Start time must be before end time');
      return;
    }

    // Validate time format (HH:MM)
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(startTime)) {
      setError('Please enter a valid time in HH:MM format');
      return;
    }

    onSave(startTime);
    onClose();
  };

  const handleCancel = () => {
    setStartTime(session.startTime);
    setError(null);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full mx-4">
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center space-x-2">
            <Clock className="text-blue-600 dark:text-blue-400" size={20} />
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              Edit Session Start Time
            </h2>
          </div>
          <button
            onClick={handleCancel}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {/* Session Info */}
          <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
            <div className="text-sm text-gray-600 dark:text-gray-400 mb-2">
              Date: {new Date(planDate).toLocaleDateString('en-US', { 
                weekday: 'long', 
                month: 'short', 
                day: 'numeric' 
              })}
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-400">
              Current: {session.startTime} - {session.endTime} ({session.allocatedHours}h)
            </div>
          </div>

          {/* Time Input */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2 dark:text-gray-200">
              New Start Time
            </label>
            <div className="relative">
              <Clock className="absolute left-3 top-2.5 text-gray-400" size={20} />
              <input
                type="time"
                value={startTime}
                onChange={(e) => {
                  setStartTime(e.target.value);
                  setError(null);
                }}
                className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              />
            </div>
            {error && (
              <p className="text-red-600 dark:text-red-400 text-sm mt-1">{error}</p>
            )}
          </div>

          {/* Warning Note */}
          <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700 rounded-lg p-4">
            <div className="flex items-start space-x-2">
              <AlertTriangle className="text-yellow-600 dark:text-yellow-400 mt-0.5" size={16} />
              <div className="text-sm text-yellow-800 dark:text-yellow-200">
                <p className="font-medium mb-1">Note about start time changes:</p>
                <p className="text-xs">
                  The start time may be automatically reset based on study window settings, 
                  new tasks, or other schedule changes. This ensures your study plan remains 
                  optimized and conflict-free.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end space-x-3 p-6 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={handleCancel}
            className="px-4 py-2 text-gray-700 dark:text-gray-300 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={startTime === session.startTime}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
};

export default SessionTimeEditModal;