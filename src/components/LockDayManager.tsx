import React, { useState } from 'react';
import { Lock, Unlock, AlertTriangle, Info, CheckCircle, X } from 'lucide-react';
import { StudyPlan, Task, UserSettings, FixedCommitment } from '../types';
import { validateDayLock, redistributeFromLockedDays, LockDayValidationResult } from '../utils/lock-day-management';
import { formatTime } from '../utils/scheduling';

interface LockDayManagerProps {
  studyPlans: StudyPlan[];
  tasks: Task[];
  settings: UserSettings;
  fixedCommitments: FixedCommitment[];
  onToggleDayLock: (date: string, isLocked: boolean) => void;
  onRedistributePlans: (newPlans: StudyPlan[]) => void;
}

interface LockConfirmationDialogProps {
  isOpen: boolean;
  validation: LockDayValidationResult;
  date: string;
  onConfirm: () => void;
  onCancel: () => void;
}

const LockConfirmationDialog: React.FC<LockConfirmationDialogProps> = ({
  isOpen,
  validation,
  date,
  onConfirm,
  onCancel
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
        <div className="flex items-center gap-2 mb-4">
          <Lock className="w-5 h-5 text-yellow-600" />
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            Lock Day Confirmation
          </h3>
        </div>

        <p className="text-gray-600 dark:text-gray-300 mb-4">
          You're about to lock {new Date(date).toLocaleDateString()} which contains {validation.affectedSessions.length} session(s).
        </p>

        {validation.blockers.length > 0 && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <X className="w-4 h-4 text-red-600" />
              <span className="font-medium text-red-800 dark:text-red-200">Cannot Lock</span>
            </div>
            {validation.blockers.map((blocker, index) => (
              <p key={index} className="text-sm text-red-700 dark:text-red-300">
                {blocker}
              </p>
            ))}
          </div>
        )}

        {validation.warnings.length > 0 && (
          <div className="mb-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 text-yellow-600" />
              <span className="font-medium text-yellow-800 dark:text-yellow-200">Warnings</span>
            </div>
            {validation.warnings.map((warning, index) => (
              <p key={index} className="text-sm text-yellow-700 dark:text-yellow-300">
                {warning}
              </p>
            ))}
          </div>
        )}

        {validation.affectedSessions.length > 0 && (
          <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <Info className="w-4 h-4 text-blue-600" />
              <span className="font-medium text-blue-800 dark:text-blue-200">Affected Sessions</span>
            </div>
            {validation.affectedSessions.slice(0, 3).map((session, index) => (
              <div key={index} className="text-sm text-blue-700 dark:text-blue-300">
                {session.startTime} - {session.endTime}: {formatTime(session.allocatedHours)}
              </div>
            ))}
            {validation.affectedSessions.length > 3 && (
              <p className="text-sm text-blue-600 dark:text-blue-400">
                ...and {validation.affectedSessions.length - 3} more
              </p>
            )}
          </div>
        )}

        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!validation.canLock}
            className={`px-4 py-2 rounded-lg font-medium ${
              validation.canLock
                ? 'bg-yellow-600 text-white hover:bg-yellow-700'
                : 'bg-gray-300 text-gray-500 cursor-not-allowed'
            }`}
          >
            {validation.canLock ? 'Lock Day' : 'Cannot Lock'}
          </button>
        </div>
      </div>
    </div>
  );
};

export const LockDayButton: React.FC<{
  date: string;
  isLocked: boolean;
  studyPlans: StudyPlan[];
  tasks: Task[];
  settings: UserSettings;
  fixedCommitments: FixedCommitment[];
  onToggleDayLock: (date: string, isLocked: boolean) => void;
  onRedistributePlans?: (newPlans: StudyPlan[]) => void;
  className?: string;
}> = ({
  date,
  isLocked,
  studyPlans,
  tasks,
  settings,
  fixedCommitments,
  onToggleDayLock,
  onRedistributePlans,
  className = ""
}) => {
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [validation, setValidation] = useState<LockDayValidationResult | null>(null);
  const [redistributionInProgress, setRedistributionInProgress] = useState(false);

  const handleLockToggle = () => {
    if (isLocked) {
      // Unlocking - check if we need to redistribute sessions back
      if (onRedistributePlans) {
        setRedistributionInProgress(true);
        const redistributionResult = redistributeFromLockedDays(
          studyPlans,
          tasks,
          settings,
          fixedCommitments
        );
        
        if (redistributionResult.success) {
          onRedistributePlans(redistributionResult.modifiedPlans);
        }
        setRedistributionInProgress(false);
      }
      onToggleDayLock(date, false);
    } else {
      // Locking - validate first
      const lockValidation = validateDayLock(date, studyPlans, tasks, settings, fixedCommitments);
      setValidation(lockValidation);
      
      if (lockValidation.canLock && lockValidation.warnings.length === 0) {
        // Direct lock if no warnings
        onToggleDayLock(date, true);
      } else {
        // Show confirmation dialog
        setShowConfirmation(true);
      }
    }
  };

  const handleConfirmLock = () => {
    onToggleDayLock(date, true);
    setShowConfirmation(false);
    setValidation(null);
  };

  const handleCancelLock = () => {
    setShowConfirmation(false);
    setValidation(null);
  };

  const Icon = isLocked ? Lock : Unlock;
  const title = isLocked 
    ? "Unlock day - Allow changes to this day's sessions"
    : "Lock day - Protect this day's sessions from changes";

  return (
    <>
      <button
        onClick={handleLockToggle}
        disabled={redistributionInProgress}
        className={`p-1.5 rounded-full transition-colors duration-200 ${
          isLocked
            ? 'text-yellow-600 hover:text-yellow-700 hover:bg-yellow-50 dark:hover:bg-yellow-900/20'
            : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'
        } ${className}`}
        title={title}
      >
        <Icon className="w-4 h-4" />
      </button>

      {validation && (
        <LockConfirmationDialog
          isOpen={showConfirmation}
          validation={validation}
          date={date}
          onConfirm={handleConfirmLock}
          onCancel={handleCancelLock}
        />
      )}
    </>
  );
};

export const LockDayManager: React.FC<LockDayManagerProps> = ({
  studyPlans,
  tasks,
  settings,
  fixedCommitments,
  onToggleDayLock,
  onRedistributePlans
}) => {
  const [showBulkActions, setShowBulkActions] = useState(false);
  const [selectedDates, setSelectedDates] = useState<string[]>([]);

  const lockedDays = studyPlans.filter(plan => plan.isLocked);
  const lockedDaysWithSessions = lockedDays.filter(plan => plan.plannedTasks.length > 0);

  const handleBulkRedistribution = async () => {
    const redistributionResult = redistributeFromLockedDays(
      studyPlans,
      tasks,
      settings,
      fixedCommitments
    );

    if (redistributionResult.success) {
      onRedistributePlans(redistributionResult.modifiedPlans);
    }
  };

  if (lockedDays.length === 0) return null;

  return (
    <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700 rounded-lg p-4 mb-4">
      <div className="flex items-center gap-2 mb-2">
        <Lock className="w-4 h-4 text-yellow-600" />
        <h3 className="font-medium text-yellow-800 dark:text-yellow-200">
          Locked Days Management
        </h3>
      </div>

      <p className="text-sm text-yellow-700 dark:text-yellow-300 mb-3">
        You have {lockedDays.length} locked day(s), {lockedDaysWithSessions.length} with sessions.
      </p>

      {lockedDaysWithSessions.length > 0 && (
        <div className="space-y-2">
          {lockedDaysWithSessions.map(plan => (
            <div key={plan.date} className="flex items-center justify-between bg-white dark:bg-gray-800 rounded p-2">
              <div>
                <span className="font-medium">{new Date(plan.date).toLocaleDateString()}</span>
                <span className="text-sm text-gray-600 dark:text-gray-400 ml-2">
                  ({plan.plannedTasks.length} sessions, {formatTime(plan.totalStudyHours)})
                </span>
              </div>
              <LockDayButton
                date={plan.date}
                isLocked={true}
                studyPlans={studyPlans}
                tasks={tasks}
                settings={settings}
                fixedCommitments={fixedCommitments}
                onToggleDayLock={onToggleDayLock}
                onRedistributePlans={onRedistributePlans}
              />
            </div>
          ))}

          <button
            onClick={handleBulkRedistribution}
            className="w-full mt-3 px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 transition-colors"
          >
            Redistribute All Sessions from Locked Days
          </button>
        </div>
      )}
    </div>
  );
};

export default LockDayManager;
