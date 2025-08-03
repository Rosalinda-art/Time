import React, { useState, useEffect } from 'react';
import { Calendar, Clock, BookOpen, TrendingUp, AlertTriangle, CheckCircle, Lightbulb, X, CheckCircle2, Clock3, Lock, Unlock, Edit, Save } from 'lucide-react';
import { StudyPlan, Task, StudySession, FixedCommitment, UserSettings } from '../types'; // Added FixedCommitment to imports
import { formatTime, generateSmartSuggestions, getLocalDateString, checkSessionStatus, getDailyAvailableTimeSlots, findNextAvailableStartTime, moveIndividualSession, redistributeMissedSessionsEnhanced, skipSessionEnhanced, validateTimeSlot } from '../utils/scheduling';
import { RedistributionOptions } from '../types';

interface StudyPlanViewProps {
  studyPlans: StudyPlan[];
  tasks: Task[];
  fixedCommitments: FixedCommitment[]; // Added fixedCommitments prop
  onSelectTask: (task: Task, session?: { allocatedHours: number; planDate?: string; sessionNumber?: number }) => void;
  onGenerateStudyPlan: () => void;
  onUndoSessionDone: (planDate: string, taskId: string, sessionNumber: number) => void;
  settings: UserSettings; // Added settings prop
  onAddFixedCommitment?: (commitment: FixedCommitment) => void; // NEW PROP
  onSkipMissedSession: (planDate: string, sessionNumber: number, taskId: string) => void;
  onRedistributeMissedSessions?: () => void; // NEW PROP for redistribution
  onEnhancedRedistribution?: () => void; // Enhanced redistribution prop
  onToggleDayLock?: (date: string, isLocked: boolean) => void; // NEW PROP for lock toggle
  onUpdateSessionTime?: (planDate: string, taskId: string, sessionNumber: number, newStartTime: string, newEndTime: string) => void; // NEW PROP for time editing
}

// Force warnings UI to be hidden for all users on first load unless they have a preference
if (typeof window !== 'undefined') {
  if (localStorage.getItem('timepilot-showWarnings') === null) {
    localStorage.setItem('timepilot-showWarnings', 'false');
  }
}

const StudyPlanView: React.FC<StudyPlanViewProps> = ({ studyPlans, tasks, fixedCommitments, onSelectTask, onGenerateStudyPlan, onUndoSessionDone, settings, onAddFixedCommitment, onSkipMissedSession, onRedistributeMissedSessions, onEnhancedRedistribution, onToggleDayLock, onUpdateSessionTime }) => {
  const [notificationMessage, setNotificationMessage] = useState<string | null>(null);
  const [] = useState<{ taskTitle: string; unscheduledMinutes: number } | null>(null);
  const [showRegenerateConfirmation, setShowRegenerateConfirmation] = useState(false);
  // Resched UI state
  const [reschedModal, setReschedModal] = useState<{ open: boolean; task: any | null }>({ open: false, task: null });
  const [reschedDate, setReschedDate] = useState<string>("");
  const [reschedTime, setReschedTime] = useState<string>("");
  // Track skipped tasks by title+deadline
  const [] = useState<{ title: string; deadline: string }[]>([]);
  const [, setShowCompromisedWarning] = useState(false);
  const [, setShowPlanStaleNotif] = useState(true);
  // Smart assistant state
  const [showSmartAssistant, setShowSmartAssistant] = useState(false);
  // Enhanced redistribution state
  const [redistributionInProgress, setRedistributionInProgress] = useState(false);
  const [redistributionResults, setRedistributionResults] = useState<{
    success: boolean;
    message: string;
    details?: { redistributed: number; failed: number; conflictsResolved: number };
  } | null>(null);
  // Persist showWarnings in localStorage
  const [showWarnings, setShowWarningsRaw] = useState(() => {
    const saved = localStorage.getItem('timepilot-showWarnings');
    return saved === null ? false : saved === 'true';
  });
  const setShowWarnings = (val: boolean | ((prev: boolean) => boolean)) => {
    const newVal = typeof val === 'function' ? val(showWarnings) : val;
    setShowWarningsRaw(newVal);
    localStorage.setItem('timepilot-showWarnings', newVal ? 'true' : 'false');
  };
  
  // Time editing state for locked days
  const [editingSessionTime, setEditingSessionTime] = useState<{
    planDate: string;
    taskId: string;
    sessionNumber: number;
    newStartTime: string;
    newEndTime: string;
  } | null>(null);

  // Hide the warning notification on mount (e.g., when switching tabs)
  useEffect(() => {
    setShowCompromisedWarning(false);
  }, []);

  useEffect(() => {
    setShowPlanStaleNotif(true);
  }, []);

  useEffect(() => {
    setShowWarnings(true);
  }, []);


  const getTaskById = (taskId: string): Task | undefined => {
    return tasks.find(task => task.id === taskId);
  };



  const getSuggestionIcon = (type: string) => {
    switch (type) {
      case 'warning': return <AlertTriangle className="text-red-500" size={20} />;
      case 'celebration': return <CheckCircle className="text-green-500" size={20} />;
      case 'suggestion': return <Lightbulb className="text-blue-500" size={20} />;
      default: return <Lightbulb className="text-gray-500" size={20} />;
    }
  };

  const today = getLocalDateString();
  console.log('StudyPlanView - Today date format check:', {
    today,
    todayType: typeof today,
    todayLength: today.length,
    todayParts: today.split('-')
  });
  const todaysPlan = studyPlans.find(plan => plan.date === today);
  console.log('today:', today, 'studyPlans:', studyPlans.map(p => p.date));
  console.log('todaysPlan found:', !!todaysPlan);
  if (todaysPlan) {
    console.log('todaysPlan sessions:', todaysPlan.plannedTasks.map(s => ({
      taskId: s.taskId,
      sessionNumber: s.sessionNumber,
      startTime: s.startTime,
      endTime: s.endTime,
      status: s.status,
      originalTime: s.originalTime,
      originalDate: s.originalDate
    })));
  }
  const upcomingPlans = studyPlans.filter(plan => plan.date > today).slice(0, 7);
  const suggestions = generateSmartSuggestions(tasks);



  // Calculate if the plan is feasible given the user's daily available hours and deadlines
  const allPendingDeadlines = tasks.filter(t => t.status === 'pending' && t.estimatedHours > 0).map(t => {
    const d = new Date(t.deadline);
    // Apply buffer days adjustment if buffer days is set
    if (settings.bufferDays > 0) {
      d.setDate(d.getDate() - settings.bufferDays);
    }
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const earliest = new Date();
  earliest.setHours(0, 0, 0, 0);
  const latest = allPendingDeadlines.length > 0 ? new Date(Math.max(...allPendingDeadlines.map(d => d.getTime()))) : earliest;
  // Count number of available study days in the window
  let availableStudyDays = 0;
  const tempDate = new Date(earliest);
  while (tempDate.getTime() <= latest.getTime()) {
    if ((settings.workDays || [1,2,3,4,5,6]).includes(tempDate.getDay())) {
      availableStudyDays++;
    }
    tempDate.setDate(tempDate.getDate() + 1);
  }

  // Helper: check if a task has a rescheduled session before its deadline


  // Function to reschedule a single session using MOVE logic
  const rescheduleIndividualSession = (item: {
    session: StudySession;
    planDate: string;
    planIndex: number;
    sessionIndex: number;
  }) => {
    // Use the new MOVE-based individual session rescheduling logic
    const { success, newTime, newDate } = moveIndividualSession(
      studyPlans,
      item.session,
      item.planDate,
      settings,
      fixedCommitments
    );
    
    if (success && newTime && newDate) {
      // Call the parent handler to update the study plans
    if (onAddFixedCommitment) {
      const newFixedCommitment: FixedCommitment = {
        id: 'manual-resched-' + Date.now(),
        title: item.session.taskId + ' (Manual Resched)',
        startTime: newTime,
        endTime: newTime, // This will be calculated properly in the parent handler
        recurring: false,
        daysOfWeek: [],
        specificDates: [newDate],
        type: 'other',
        createdAt: new Date().toISOString(),
      };
      onAddFixedCommitment(newFixedCommitment);
      setNotificationMessage(
        `Added fixed commitment: ${newFixedCommitment.title} on ${newDate} from ${newTime} to ${newTime}`
      );
    } else {
      setNotificationMessage(`Moved ${getTaskById(item.session.taskId)?.title || 'session'} to ${newTime}`);
    }
    
    // Remove this session from the reschedule UI
    
    } else {
      setNotificationMessage(`Failed to move ${getTaskById(item.session.taskId)?.title || 'session'}`);
    }
  };



  // --- Missed Sessions Section ---
  // Gather all missed sessions from past studyPlans (excluding today's overdue sessions)
  const missedSessions: Array<{planDate: string, session: StudySession, task: Task}> = [];
  
  // Only include past plans (not today's plan)
  const plansToCheck = studyPlans.filter(plan => plan.date < today);
  
  plansToCheck.forEach(plan => {
    plan.plannedTasks.forEach(session => {
      const sessionStatus = checkSessionStatus(session, plan.date);
      // Only consider sessions as missed if they were originally scheduled for that date
      // and not redistributed there
      const isRedistributedToPast = session.originalTime && session.originalDate && plan.date < today;
      
      if (sessionStatus === 'missed' && !isRedistributedToPast) {
        const task = getTaskById(session.taskId);
        if (task) {
          console.log(`Found missed session: ${task.title} on ${plan.date}, status: ${sessionStatus}, sessionNumber: ${session.sessionNumber}`);
          missedSessions.push({ planDate: plan.date, session, task });
        }
      }
    });
  });

  // Debug logging
  console.log('Today:', today);
  console.log('All study plans:', studyPlans.map(p => ({ date: p.date, tasks: p.plannedTasks.length })));
  console.log('Plans to check (past + today):', plansToCheck.map(p => p.date));
  console.log('Plans to check count:', plansToCheck.length);
  console.log('Missed sessions found:', missedSessions.length);
  
  // Check each plan's date comparison
  studyPlans.forEach((plan, index) => {
    const isPastOrToday = plan.date <= today;
    console.log(`Plan ${index}: date="${plan.date}", isPastOrToday=${isPastOrToday}, comparison: "${plan.date}" <= "${today}" = ${plan.date <= today}`);
    if (index === 0) {
      console.log('First plan date format check:', {
        date: plan.date,
        dateType: typeof plan.date,
        dateLength: plan.date.length,
        dateParts: plan.date.split('-')
      });
    }
  });
  
  missedSessions.forEach(ms => {
    console.log('Missed session:', ms.task.title, 'on', ms.planDate, 'status:', checkSessionStatus(ms.session, ms.planDate));
  });

  // Enhanced handler to skip a missed session with partial skip support
  const handleSkipMissedSession = (planDate: string, sessionNumber: number, taskId: string, partialHours?: number) => {
    if (partialHours) {
      // Use enhanced skip functionality for partial skipping
      const success = skipSessionEnhanced(studyPlans, planDate, sessionNumber, taskId, {
        partialHours,
        reason: 'user_choice'
      });

      if (success) {
        setNotificationMessage(`Partially skipped ${formatTime(partialHours)} of session. Remaining time will be rescheduled.`);
        // Force a re-render by calling the parent's redistribution handler
        if (onRedistributeMissedSessions) {
          onRedistributeMissedSessions();
        }
      } else {
        setNotificationMessage('Failed to partially skip session.');
      }
    } else {
      // Full skip using original method
      onSkipMissedSession(planDate, sessionNumber, taskId);
      setNotificationMessage('Session skipped! It will not be redistributed in future plans.');
    }
  };

  // Lock day handler
  const handleToggleDayLock = (date: string, currentLockState: boolean) => {
    if (onToggleDayLock) {
      onToggleDayLock(date, !currentLockState);
      setNotificationMessage(
        !currentLockState 
          ? `Day locked! Sessions on ${new Date(date).toLocaleDateString()} are now protected from changes.`
          : `Day unlocked! Sessions on ${new Date(date).toLocaleDateString()} can now be modified.`
      );
      setTimeout(() => setNotificationMessage(null), 3000);
    }
  };

  // Time editing handlers for locked days
  const handleStartTimeEdit = (planDate: string, taskId: string, sessionNumber: number, currentStartTime: string, currentEndTime: string) => {
    setEditingSessionTime({
      planDate,
      taskId,
      sessionNumber,
      newStartTime: currentStartTime,
      newEndTime: currentEndTime
    });
  };

  const handleTimeEditSave = () => {
    if (!editingSessionTime || !onUpdateSessionTime) return;

    const { planDate, taskId, sessionNumber, newStartTime, newEndTime } = editingSessionTime;
    
    // Validate time format and logic
    if (newStartTime >= newEndTime) {
      setNotificationMessage('End time must be after start time.');
      setTimeout(() => setNotificationMessage(null), 3000);
      return;
    }

    // Check for overlaps with other sessions and commitments
    const plan = studyPlans.find(p => p.date === planDate);
    if (!plan) return;

    const otherSessions = plan.plannedTasks.filter(s => 
      !(s.taskId === taskId && s.sessionNumber === sessionNumber)
    );

    // Check for session overlaps
    const hasOverlap = otherSessions.some(session => {
      return (newStartTime < session.endTime && newEndTime > session.startTime);
    });

    if (hasOverlap) {
      setNotificationMessage('Time conflicts with another session. Please choose a different time.');
      setTimeout(() => setNotificationMessage(null), 3000);
      return;
    }

    // Check for commitment overlaps
    const dayOfWeek = new Date(planDate).getDay();
    const hasCommitmentOverlap = fixedCommitments.some(commitment => {
      if (commitment.recurring && commitment.daysOfWeek.includes(dayOfWeek)) {
        return (newStartTime < commitment.endTime && newEndTime > commitment.startTime);
      }
      if (!commitment.recurring && commitment.specificDates?.includes(planDate)) {
        return (newStartTime < commitment.endTime && newEndTime > commitment.startTime);
      }
      return false;
    });

    if (hasCommitmentOverlap) {
      setNotificationMessage('Time conflicts with a fixed commitment. Please choose a different time.');
      setTimeout(() => setNotificationMessage(null), 3000);
      return;
    }

    // Call the parent handler to update session time
    onUpdateSessionTime(planDate, taskId, sessionNumber, newStartTime, newEndTime);

    setEditingSessionTime(null);
    setNotificationMessage('Session time updated successfully!');
    setTimeout(() => setNotificationMessage(null), 3000);
  };

  const handleTimeEditCancel = () => {
    setEditingSessionTime(null);
  };

  // Enhanced redistribution handler
  const handleEnhancedRedistribution = async () => {
    if (redistributionInProgress) return;

    setRedistributionInProgress(true);
    setRedistributionResults(null);

    try {
      // Use parent handler if available (preferred), otherwise use local implementation
      if (onEnhancedRedistribution) {
        onEnhancedRedistribution();
        setRedistributionResults({
          success: true,
          message: 'Enhanced redistribution completed!'
        });
      } else {
        // Fallback to local implementation
        const options: RedistributionOptions = {
          prioritizeMissedSessions: true,
          respectDailyLimits: true,
          allowWeekendOverflow: false,
          maxRedistributionDays: 14
        };

        const result = redistributeMissedSessionsEnhanced(
          studyPlans,
          settings,
          fixedCommitments,
          tasks,
          options
        );

        setRedistributionResults({
          success: result.totalSessionsMoved > 0,
          message: result.totalSessionsMoved > 0
            ? `Successfully redistributed ${result.totalSessionsMoved} session${result.totalSessionsMoved > 1 ? 's' : ''}!`
            : 'No sessions could be redistributed. Check your schedule for available time slots.',
          details: {
            redistributed: result.totalSessionsMoved,
            failed: result.failedSessions.length,
            conflictsResolved: result.conflictsResolved
          }
        });

        if (result.totalSessionsMoved > 0) {
          setNotificationMessage(`Redistribution complete: ${result.totalSessionsMoved} sessions moved, ${result.failedSessions.length} failed`);
        }
      }

    } catch (error) {
      console.error('Enhanced redistribution failed:', error);
      setRedistributionResults({
        success: false,
        message: 'Redistribution failed due to an error. Please try again.'
      });
    } finally {
      setRedistributionInProgress(false);
    }
  };


  const todayDateObj = new Date();
  const todayDayOfWeek = todayDateObj.getDay();
  const isTodayWorkDay = (settings.workDays || [1,2,3,4,5,6]).includes(todayDayOfWeek);

  const activeTasks = tasks.filter(task => task.status === 'pending' && task.estimatedHours > 0);

  return (
    <div className="space-y-6 relative study-plan-container">
      {/* Missed Sessions Section */}
      {missedSessions.length > 0 && (
        <div className={`bg-white rounded-xl shadow-lg p-6 mb-6 dark:bg-gray-900 dark:shadow-gray-900 border-l-4 ${missedSessions.length > 0 ? 'border-red-500' : 'border-gray-300 dark:border-gray-600'}`}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center space-x-2">
              <AlertTriangle className={`${missedSessions.length > 0 ? 'text-red-500 dark:text-red-400' : 'text-gray-400 dark:text-gray-500'}`} size={24} />
              <h2 className="text-xl font-semibold text-gray-800 dark:text-white">Missed Sessions</h2>
              <span className={`px-2 py-1 text-xs rounded-full ${
                missedSessions.length > 0 
                  ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300' 
                  : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
              }`}>
                {missedSessions.length} missed
              </span>
            </div>
            <div className="flex space-x-2">
              <button
                onClick={handleEnhancedRedistribution}
                disabled={redistributionInProgress}
                className="px-4 py-2 bg-gradient-to-r from-blue-500 to-purple-600 text-white text-sm rounded-lg hover:from-blue-600 hover:to-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Intelligently redistribute missed sessions with conflict prevention"
              >
                {redistributionInProgress ? (
                  <div className="flex items-center space-x-2">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    <span>Redistributing...</span>
                  </div>
                ) : (
                  'Smart Redistribution'
                )}
              </button>
              <button
                onClick={onRedistributeMissedSessions || onGenerateStudyPlan}
                className="px-4 py-2 bg-gray-500 text-white text-sm rounded-lg hover:bg-gray-600 transition-colors"
                title="Use legacy redistribution method"
              >
                Legacy Mode
              </button>
            </div>
          </div>
          
          <div className="mb-4 text-sm text-gray-600 dark:text-gray-300">
            {missedSessions.length > 0 ? (
              <>
                <p>You have missed {missedSessions.length} study session{missedSessions.length > 1 ? 's' : ''}. You can:</p>
                <ul className="mt-2 space-y-1">
                  <li>• <strong>Skip</strong> missed sessions (they won't be redistributed)</li>
                  <li>• <strong>Smart Redistribution</strong> uses conflict-free scheduling with priority-based placement</li>
                  <li>• <strong>Start studying</strong> any missed session now</li>
                </ul>
              </>
            ) : (
              <p>No missed sessions found. All past study sessions have been completed or are up to date.</p>
            )}
          </div>

          {/* Redistribution Results */}
          {redistributionResults && (
            <div className={`mb-4 p-4 rounded-lg border-l-4 ${
              redistributionResults.success
                ? 'bg-green-50 border-green-500 dark:bg-green-900/20 dark:border-green-400'
                : 'bg-red-50 border-red-500 dark:bg-red-900/20 dark:border-red-400'
            }`}>
              <div className="flex items-center justify-between">
                <div>
                  <p className={`font-medium ${
                    redistributionResults.success
                      ? 'text-green-800 dark:text-green-200'
                      : 'text-red-800 dark:text-red-200'
                  }`}>
                    {redistributionResults.message}
                  </p>
                  {redistributionResults.details && (
                    <div className="mt-2 text-xs text-gray-600 dark:text-gray-300">
                      <p>• Sessions redistributed: {redistributionResults.details.redistributed}</p>
                      <p>• Failed redistributions: {redistributionResults.details.failed}</p>
                      <p>• Conflicts resolved: {redistributionResults.details.conflictsResolved}</p>
                    </div>
                  )}
                </div>
                <button
                  onClick={() => setRedistributionResults(null)}
                  className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
          )}

          <div className="space-y-3">
                        {missedSessions.length > 0 ? (
              missedSessions.map(({planDate, session, task}, idx) => (
                <div key={`missed-${planDate}-${session.sessionNumber || 0}-${task.id}-${session.startTime || ''}-${idx}`} 
                     className="flex items-center justify-between bg-gray-50 dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700 hover:shadow-md transition-all duration-200">
                <div className="flex-1">
                  <div className="flex items-center space-x-2 mb-2">
                    <BookOpen className="text-blue-500 dark:text-blue-400" size={18} />
                    <h3 className="font-medium text-gray-800 dark:text-white">{task.title}</h3>
                    {task.category && (
                      <span className="px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded-full dark:bg-blue-900 dark:text-blue-300">
                        {task.category}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center space-x-4 text-sm text-gray-500 dark:text-gray-400">
                    <span className="flex items-center space-x-1">
                      <Calendar size={14} />
                      <span>{planDate}</span>
                    </span>
                    <span className="flex items-center space-x-1">
                      <Clock size={14} />
                      <span>{session.startTime} - {session.endTime}</span>
                    </span>
                    <span className="flex items-center space-x-1">
                      <TrendingUp size={14} />
                      <span>{formatTime(session.allocatedHours)}</span>
                    </span>
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => onSelectTask(task, { allocatedHours: session.allocatedHours, planDate, sessionNumber: session.sessionNumber })}
                    className="px-3 py-1 text-xs bg-green-100 text-green-800 rounded-lg hover:bg-green-200 transition-colors duration-200 dark:bg-green-900 dark:text-green-200 dark:hover:bg-green-800"
                  >
                    Start Now
                  </button>
                  <button
                    onClick={() => handleSkipMissedSession(planDate, session.sessionNumber || 0, task.id)}
                    className="px-3 py-1 text-xs bg-yellow-100 text-yellow-800 rounded-lg hover:bg-yellow-200 transition-colors duration-200 dark:bg-yellow-900 dark:text-yellow-200 dark:hover:bg-yellow-800"
                  >
                    Skip All
                  </button>
                  {session.allocatedHours > 0.5 && (
                    <button
                      onClick={() => handleSkipMissedSession(planDate, session.sessionNumber || 0, task.id, session.allocatedHours / 2)}
                      className="px-3 py-1 text-xs bg-blue-100 text-blue-800 rounded-lg hover:bg-blue-200 transition-colors duration-200 dark:bg-blue-900 dark:text-blue-200 dark:hover:bg-blue-800"
                      title={`Skip ${formatTime(session.allocatedHours / 2)} and reschedule the rest`}
                    >
                      Skip Half
                    </button>
                  )}
                </div>
              </div>
            ))
            ) : (
              <div className="text-center py-4 text-gray-500 dark:text-gray-400">
                <CheckCircle className="text-green-500 dark:text-green-400 mx-auto mb-2" size={24} />
                <p>All past sessions are up to date!</p>
              </div>
            )}
          </div>
        </div>
      )}
      {/* Resched Modal */}
      {reschedModal.open && reschedModal.task && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl max-w-md w-full mx-4">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold text-gray-800 dark:text-white flex items-center space-x-2">
                  <Clock className="text-blue-500" size={24} />
                  <span>Reschedule Unscheduled Hours</span>
                </h2>
                <button
                  onClick={() => setReschedModal({ open: false, task: null })}
                  className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                >
                  <X size={24} />
                </button>
              </div>
              <div className="mb-4">
                <div className="font-semibold text-gray-700 dark:text-gray-200 mb-1">{reschedModal.task.title}</div>
                <div className="text-sm text-gray-600 dark:text-gray-300 mb-2">
                  {reschedModal.task.unscheduledHours >= 1
                    ? `${Math.floor(reschedModal.task.unscheduledHours)} hour${reschedModal.task.unscheduledHours >= 2 ? 's' : ''}`
                    : `${Math.round(reschedModal.task.unscheduledHours * 60)} min`} unscheduled
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-200">Select Day</label>
                  <input
                    type="date"
                    className="border rounded px-2 py-1 dark:bg-gray-700 dark:text-white"
                    value={reschedDate}
                    onChange={e => setReschedDate(e.target.value)}
                  />
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-200 mt-2">Select Start Time</label>
                  <input
                    type="time"
                    className="border rounded px-2 py-1 dark:bg-gray-700 dark:text-white"
                    value={reschedTime}
                    onChange={e => setReschedTime(e.target.value)}
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-4">
                <button
                  onClick={() => setReschedModal({ open: false, task: null })}
                  className="px-4 py-2 text-gray-700 bg-gray-200 rounded-lg hover:bg-gray-300 transition-colors dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
                >
                  Cancel
                </button>
                <button
                  disabled={!reschedDate || !reschedTime}
                  onClick={() => {
                    // Calculate end time
                    const [reschedHour, reschedMinute] = reschedTime.split(":").map(Number);
                    const reschedStartDate = new Date(reschedDate + 'T' + reschedTime);
                    const reschedEndDate = new Date(reschedStartDate.getTime() + reschedModal.task.unscheduledHours * 60 * 60 * 1000);
                    const pad = (n: number) => n.toString().padStart(2, '0');
                    const reschedStartTime = pad(reschedHour) + ':' + pad(reschedMinute);
                    const reschedEndTime = pad(reschedEndDate.getHours()) + ':' + pad(reschedEndDate.getMinutes());
                    const reschedDayOfWeek = new Date(reschedDate).getDay();
                    const newFixedCommitment: FixedCommitment = {
                      id: 'manual-resched-' + Date.now(),
                      title: reschedModal.task.title + ' (Manual Resched)',
                      startTime: reschedStartTime,
                      endTime: reschedEndTime,
                      recurring: false,
                      daysOfWeek: [],
                      specificDates: [reschedDate],
                      type: 'other',
                      createdAt: new Date().toISOString(),
                    };
                    if (onAddFixedCommitment) {
                      onAddFixedCommitment(newFixedCommitment);
                      setNotificationMessage(
                        `Added fixed commitment: ${newFixedCommitment.title} on ${reschedDate} from ${reschedStartTime} to ${reschedEndTime}`
                      );
                    } else {
                      setNotificationMessage(
                        `Added fixed commitment: ${newFixedCommitment.title} on ${reschedDate} from ${reschedStartTime} to ${reschedEndTime}`
                      );
                    }
                    setReschedModal({ open: false, task: null });
                  }}
                  className={`px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors ${(!reschedDate || !reschedTime) ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  Confirm
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Test Data Setup (Development Only) */}
      {process.env.NODE_ENV === 'development' && (
        <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg dark:bg-yellow-900/20 dark:border-yellow-800">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-yellow-800 dark:text-yellow-200">🧪 Testing Mode</h3>
              <p className="text-xs text-yellow-600 dark:text-yellow-300 mt-1">
                Click to create test data with missed sessions to test the enhanced redistribution system
              </p>
            </div>
            <button
              onClick={() => {
                if ((window as any).setupTestData) {
                  (window as any).setupTestData();
                } else {
                  setNotificationMessage('Test data setup not available');
                }
              }}
              className="px-3 py-1 text-xs bg-yellow-100 text-yellow-800 rounded-lg hover:bg-yellow-200 transition-colors dark:bg-yellow-900 dark:text-yellow-200 dark:hover:bg-yellow-800"
            >
              Setup Test Data
            </button>
          </div>
        </div>
      )}

      {/* Generate Study Plan Button (only if no study plan exists and there are active tasks) */}
      {studyPlans.length === 0 && activeTasks.length > 0 && (
      <div className="flex justify-end space-x-3">
        <button
            className={`px-4 py-2 rounded-lg font-semibold shadow transition-colors duration-200 bg-gradient-to-r from-blue-500 to-purple-600 text-white hover:from-blue-600 hover:to-purple-700`}
          onClick={() => {
              setShowRegenerateConfirmation(true);
          }}
        >
            Generate Study Plan
        </button>
      </div>
      )}

      {/* Generate Confirmation Modal */}
      {showRegenerateConfirmation && studyPlans.length === 0 && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl max-w-md w-full mx-4">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold text-gray-800 dark:text-white flex items-center space-x-2">
                  <AlertTriangle className="text-orange-500" size={24} />
                  <span>Generate Study Plan?</span>
                </h2>
                <button
                  onClick={() => setShowRegenerateConfirmation(false)}
                  className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                >
                  <X size={24} />
                </button>
              </div>
              <div className="space-y-4">
                <p className="text-gray-600 dark:text-gray-300">
                  This will create a new study plan based on your current active tasks and settings.
                </p>
                  </div>
              <div className="flex justify-end space-x-3 mt-6">
                <button
                  onClick={() => setShowRegenerateConfirmation(false)}
                  className="px-4 py-2 text-gray-700 bg-gray-200 rounded-lg hover:bg-gray-300 transition-colors dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    onGenerateStudyPlan();
                    setShowRegenerateConfirmation(false);
                    setNotificationMessage('Study plan generated successfully!');
                    setTimeout(() => setNotificationMessage(null), 3000);
                  }}
                  className="px-4 py-2 bg-gradient-to-r from-blue-500 to-purple-600 text-white rounded-lg hover:from-blue-600 hover:to-purple-700 transition-colors"
                >
                  Yes, Generate Plan
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Reschedule Options Modal */}
      

      {/* Notification Message */}
      {notificationMessage && (
        <div className={`p-4 rounded-lg flex items-center justify-between ${
          notificationMessage.includes('successfully') ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
        }`}>
          <p className="font-medium">{notificationMessage}</p>
          <button onClick={() => setNotificationMessage(null)} className="text-current hover:opacity-75">
            <X size={20} />
          </button>
        </div>
      )}


      
      {/* Today's Study Plan */}
      {!isTodayWorkDay ? (
        <div className="bg-white rounded-xl shadow-lg p-6 mb-6 dark:bg-gray-900 dark:shadow-gray-900">
          <div className="flex items-center mb-4">
            <Calendar className="text-blue-600 dark:text-blue-400" size={24} />
            <h2 className="text-xl font-semibold text-gray-800 ml-2 dark:text-white">Today's Sessions</h2>
          </div>
          <div className="text-center py-8">
            <div className="text-6xl mb-4">🎉</div>
            <h3 className="text-xl font-semibold text-gray-800 mb-2 dark:text-white">No Work Today!</h3>
            <p className="text-gray-600 dark:text-gray-300 mb-4">
              It's your day off! Time to relax, recharge, and maybe catch up on some Netflix. ����
            </p>
            <div className="bg-gradient-to-r from-purple-100 to-pink-100 dark:from-purple-900 dark:to-pink-900 rounded-lg p-4">
              <p className="text-sm text-gray-700 dark:text-gray-200">
                <span className="font-medium">Pro tip:</span> Use this time to plan your next study session or just enjoy your well-deserved break! ✨
              </p>
            </div>
          </div>
        </div>
      ) : todaysPlan ? (
        <div className="bg-white rounded-xl shadow-lg p-6 mb-6 dark:bg-gray-900 dark:shadow-gray-900">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-gray-800 flex items-center space-x-2 dark:text-white">
              <Calendar className="text-blue-600 dark:text-blue-400" size={24} />
              <span>Today's Sessions</span>
              {todaysPlan.isLocked && (
                <span className="inline-flex items-center px-2 py-1 text-xs bg-red-100 text-red-800 rounded-full dark:bg-red-900 dark:text-red-300" title="Day is locked - sessions are protected from automatic changes, but you can manually edit session times">
                  <Lock size={12} className="mr-1" />
                  Locked
                </span>
              )}
              {suggestions.length > 0 && (
                <button 
                  onClick={() => setShowSmartAssistant(!showSmartAssistant)}
                  className="ml-2 p-1.5 bg-yellow-100 hover:bg-yellow-200 rounded-full transition-colors duration-200 dark:bg-yellow-900 dark:hover:bg-yellow-800"
                  title="Smart Assistant Tips"
                >
                  <Lightbulb className="text-yellow-600 dark:text-yellow-400" size={16} />
                </button>
              )}
              <button 
                onClick={() => handleToggleDayLock(todaysPlan.date, todaysPlan.isLocked || false)}
                className={`ml-2 p-1.5 rounded-full transition-colors duration-200 ${
                  todaysPlan.isLocked 
                    ? 'bg-red-100 hover:bg-red-200 dark:bg-red-900 dark:hover:bg-red-800' 
                    : 'bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600'
                }`}
                title={todaysPlan.isLocked ? "Unlock day - Allow changes to today's sessions" : "Lock day - Protect today's sessions from changes"}
              >
                {todaysPlan.isLocked ? (
                  <Lock className="text-red-600 dark:text-red-400" size={16} />
                ) : (
                  <Unlock className="text-gray-600 dark:text-gray-400" size={16} />
                )}
              </button>
            </h2>
            <div className="flex items-center space-x-4">
              <div className="text-sm text-gray-500 dark:text-gray-300">
                {formatTime(todaysPlan.plannedTasks.filter(session => {
                  const sessionStatus = checkSessionStatus(session, todaysPlan.date);
                  return sessionStatus !== 'missed' && session.status !== 'skipped';
                }).reduce((sum, session) => sum + session.allocatedHours, 0))} of work planned
              </div>
              {todaysPlan.isOverloaded && (
                <div className="flex items-center space-x-2">
                  <span className="px-2 py-1 text-xs bg-red-100 text-red-800 rounded-full dark:bg-red-900 dark:text-red-300">
                    Busy day!
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    ({formatTime(todaysPlan.plannedTasks.filter(session => {
                      const sessionStatus = checkSessionStatus(session, todaysPlan.date);
                      return sessionStatus !== 'missed' && session.status !== 'skipped';
                    }).reduce((sum, session) => sum + session.allocatedHours, 0))} / {formatTime(settings.dailyAvailableHours)} study hours)
                  </span>
                  <span className="text-xs text-blue-500 dark:text-blue-400" title="Buffer time between sessions is not counted in study hours">
                    + buffer time
                  </span>
                </div>
              )}
            </div>
          </div>
          
          {/* Smart Assistant Content */}
          {showSmartAssistant && suggestions.length > 0 && (
            <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg dark:bg-yellow-900/20 dark:border-yellow-800">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-yellow-800 dark:text-yellow-200 flex items-center space-x-2">
                  <Lightbulb className="text-yellow-600 dark:text-yellow-400" size={16} />
                  <span>Smart Assistant Tips</span>
                </h3>
                <button 
                  onClick={() => setShowSmartAssistant(false)}
                  className="text-yellow-600 hover:text-yellow-800 dark:text-yellow-400 dark:hover:text-yellow-200"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="space-y-2">
                {suggestions.map((suggestion, index) => (
                  <div key={index} className={`p-3 rounded-lg border-l-3 ${
                    suggestion.type === 'warning' ? 'border-l-red-400 bg-red-50 dark:bg-red-900/20 dark:border-l-red-600' :
                    suggestion.type === 'celebration' ? 'border-l-green-400 bg-green-50 dark:bg-green-900/20 dark:border-l-green-600' :
                    'border-l-blue-400 bg-blue-50 dark:bg-blue-900/20 dark:border-l-blue-600'
                  }`}>
                    <div className="flex items-start space-x-2">
                      {getSuggestionIcon(suggestion.type)}
                      <div>
                        <p className="text-sm font-medium text-gray-800 dark:text-white">{suggestion.message}</p>
                        {suggestion.action && (
                          <p className="text-xs text-gray-600 mt-1 dark:text-gray-300">💡 {suggestion.action}</p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {todaysPlan.plannedTasks
            .filter(session => session.status !== 'skipped') // Hide skipped sessions from UI
            .map((session, index) => {
            const task = getTaskById(session.taskId);
            if (!task) return null;
            const isDone = session.done;
            const isCompleted = session.status === 'completed';
            
            // Check session status for missed/overdue/rescheduled
            const sessionStatus = checkSessionStatus(session, todaysPlan.date);
            const isRescheduled = sessionStatus === 'rescheduled';
            
            // Enhanced color system for session status and importance
            const statusColors = {
              completed: {
                bg: 'bg-emerald-50 border-l-emerald-500 dark:bg-emerald-900/20 dark:border-l-emerald-400',
                text: 'text-emerald-700 dark:text-emerald-300',
                icon: 'text-emerald-500 dark:text-emerald-400',
                badge: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-800 dark:text-emerald-200'
              },
              missed: {
                bg: 'bg-red-50 border-l-red-500 dark:bg-red-900/20 dark:border-l-red-400',
                text: 'text-red-700 dark:text-red-300',
                icon: 'text-red-500 dark:text-red-400',
                badge: 'bg-red-100 text-red-800 dark:bg-red-800 dark:text-red-200'
              },
              overdue: {
                bg: 'bg-amber-50 border-l-amber-500 dark:bg-amber-900/20 dark:border-l-amber-400',
                text: 'text-amber-700 dark:text-amber-300',
                icon: 'text-amber-500 dark:text-amber-400',
                badge: 'bg-amber-100 text-amber-800 dark:bg-amber-800 dark:text-amber-200'
              },
              rescheduled: {
                bg: 'bg-indigo-50 border-l-indigo-500 dark:bg-indigo-900/20 dark:border-l-indigo-400',
                text: 'text-indigo-700 dark:text-indigo-300',
                icon: 'text-indigo-500 dark:text-indigo-400',
                badge: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-800 dark:text-indigo-200'
              },
              scheduled: {
                bg: 'bg-slate-50 border-l-slate-300 dark:bg-slate-900/20 dark:border-l-slate-400',
                text: 'text-slate-700 dark:text-slate-300',
                icon: 'text-slate-500 dark:text-slate-400',
                badge: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200'
              }
            };

            const importanceColors = {
              high: {
                ring: 'ring-2 ring-purple-200 dark:ring-purple-800',
                badge: 'bg-purple-100 text-purple-800 dark:bg-purple-800 dark:text-purple-200',
                icon: 'text-purple-500 dark:text-purple-400'
              },
              low: {
                ring: '',
                badge: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
                icon: 'text-slate-500 dark:text-slate-400'
              }
            };

            // Determine session status and styling
            let currentSessionStatus = 'scheduled';
            let icon = null;
            let statusText = '';
            
            if (isDone || isCompleted) {
              currentSessionStatus = 'completed';
              icon = <CheckCircle2 className={`${statusColors.completed.icon}`} size={20} />;
            } else if (sessionStatus === 'missed') {
              currentSessionStatus = 'missed';
              icon = <AlertTriangle className={`${statusColors.missed.icon}`} size={20} />;
              statusText = 'Missed';
            } else if (sessionStatus === 'overdue') {
              currentSessionStatus = 'overdue';
              icon = <Clock3 className={`${statusColors.overdue.icon}`} size={20} />;
              statusText = 'Overdue';
            } else if (isRescheduled) {
              currentSessionStatus = 'rescheduled';
              icon = <Clock3 className={`${statusColors.rescheduled.icon}`} size={20} />;
              statusText = 'Rescheduled';
            } else {
              icon = <Clock3 className={`${statusColors.scheduled.icon}`} size={20} />;
            }

            const currentStatusColors = statusColors[currentSessionStatus as keyof typeof statusColors];
            const importanceLevel = task.importance ? 'high' : 'low';
            const importanceStyle = importanceColors[importanceLevel];
            
                          return (
                <div
                  key={`today-${session.taskId}-${session.sessionNumber || 0}-${session.startTime || ''}-${todaysPlan.date}`}
                  className={`p-4 border-l-4 rounded-lg study-session-item ${!isDone && !isCompleted && sessionStatus !== 'missed' ? 'cursor-pointer hover:shadow-md' : 'cursor-default'} transition-all duration-200 flex items-center justify-between ${currentStatusColors.bg} ${importanceStyle.ring}`}
                  onClick={() => !isDone && !isCompleted && sessionStatus !== 'missed' && todaysPlan && onSelectTask(task, { allocatedHours: session.allocatedHours, planDate: todaysPlan.date, sessionNumber: session.sessionNumber })}
                >
                <div className={`flex-1 ${isDone || isCompleted ? 'pointer-events-none' : ''}`}>
                  <div className="flex items-center space-x-2 mb-2">
                    {icon && <span className="mr-2">{icon}</span>}
                    <h3 className={`font-medium ${
                      isDone || isCompleted || sessionStatus === 'missed' 
                        ? 'line-through text-gray-500 dark:text-gray-400' 
                        : currentStatusColors.text
                    }`}>
                      {task.title}
                    </h3>
                    {task.category && (
                      <span className="text-sm text-gray-500 dark:text-gray-300">({task.category})</span>
                    )}
                    {statusText && (
                      <span className={`px-2 py-1 text-xs rounded-full font-medium ${currentStatusColors.badge}`}>
                        {statusText}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center space-x-4 text-sm text-gray-600 dark:text-gray-200">
                    <div className="flex items-center space-x-1">
                      <Clock size={16} />
                      {editingSessionTime && 
                       editingSessionTime.planDate === todaysPlan.date && 
                       editingSessionTime.taskId === session.taskId && 
                       editingSessionTime.sessionNumber === session.sessionNumber ? (
                        <div className="flex items-center space-x-2">
                          <input
                            type="time"
                            value={editingSessionTime.newStartTime}
                            onChange={(e) => setEditingSessionTime({
                              ...editingSessionTime,
                              newStartTime: e.target.value
                            })}
                            className="px-2 py-1 border rounded text-xs dark:bg-gray-700 dark:border-gray-600"
                          />
                          <span>-</span>
                          <input
                            type="time"
                            value={editingSessionTime.newEndTime}
                            onChange={(e) => setEditingSessionTime({
                              ...editingSessionTime,
                              newEndTime: e.target.value
                            })}
                            className="px-2 py-1 border rounded text-xs dark:bg-gray-700 dark:border-gray-600"
                          />
                          <button
                            onClick={handleTimeEditSave}
                            className="p-1 text-green-600 hover:text-green-800 dark:text-green-400"
                            title="Save time changes"
                          >
                            <Save size={14} />
                          </button>
                          <button
                            onClick={handleTimeEditCancel}
                            className="p-1 text-gray-600 hover:text-gray-800 dark:text-gray-400"
                            title="Cancel editing"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center space-x-2">
                          <span>{session.startTime} - {session.endTime}</span>
                          {todaysPlan.isLocked && !isDone && !isCompleted && sessionStatus !== 'missed' && (
                            <button
                              onClick={() => handleStartTimeEdit(
                                todaysPlan.date, 
                                session.taskId, 
                                session.sessionNumber || 0, 
                                session.startTime, 
                                session.endTime
                              )}
                              className="p-1 text-blue-600 hover:text-blue-800 dark:text-blue-400 opacity-60 hover:opacity-100"
                              title="Edit session time (locked day only)"
                            >
                              <Edit size={12} />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center space-x-1">
                      <TrendingUp size={16} />
                      <span>
                        {formatTime(session.allocatedHours)}
                      </span>
                    </div>
                    {isRescheduled && session.originalTime && (
                      <div className="flex items-center space-x-1 text-xs text-blue-600 dark:text-blue-400">
                        <span>Moved from {session.originalTime}</span>
                        {session.originalDate && session.originalDate !== todaysPlan.date && (
                          <span>({new Date(session.originalDate).toLocaleDateString()})</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <div className={`flex flex-col items-end space-y-2 ml-4 ${isDone || isCompleted ? 'pointer-events-none' : ''}`}>
                  <div className="text-sm text-gray-500 dark:text-gray-300">
                    Due: {new Date(task.deadline).toLocaleDateString()}
                  </div>
                  <span className={`px-2 py-1 text-xs rounded-full ml-4 ${importanceStyle.badge} ${isDone || isCompleted ? 'opacity-50' : ''}`}>
                    {task.importance ? 'Important' : 'Not Important'}
                  </span>
                </div>
                {/* Undo button for completed sessions */}
                {(isDone || isCompleted) && (
                  <button
                    onClick={e => { 
                      e.stopPropagation(); 
                      if (todaysPlan) {
                        onUndoSessionDone(todaysPlan.date, session.taskId, session.sessionNumber || 0);
                      }
                    }}
                    className="ml-4 px-3 py-1 text-xs bg-orange-100 text-orange-700 rounded-lg hover:bg-orange-200 transition-colors duration-200 dark:bg-orange-900 dark:text-orange-300 dark:hover:bg-orange-800"
                    title="Undo completion"
                  >
                    Undo
                  </button>
                )}
                {/* Undo button for rescheduled sessions */}
                {isRescheduled && session.originalTime && (
                  <div className="flex space-x-2 ml-4">
                    <button
                      onClick={e => { 
                        e.stopPropagation(); 
                        onSkipMissedSession(todaysPlan.date, session.sessionNumber || 0, session.taskId);
                      }}
                      className="px-3 py-1 text-xs bg-yellow-100 text-yellow-800 rounded-lg hover:bg-yellow-200 transition-colors duration-200 dark:bg-yellow-900 dark:text-yellow-200 dark:hover:bg-yellow-800"
                      title="Skip this rescheduled session"
                    >
                      Skip
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          
          {/* Show "No Sessions Planned" message when all sessions are filtered out */}
          {todaysPlan.plannedTasks.filter(session => session.status !== 'skipped').length === 0 && (
            <div className="text-center py-8">
              <div className="text-4xl mb-4">📚</div>
              <h3 className="text-xl font-semibold text-gray-800 mb-2 dark:text-white">No Sessions Planned</h3>
              <p className="text-gray-600 dark:text-gray-300">
                You have no study sessions planned for today. Time to generate a study plan! 🚀
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-lg p-6 mb-6 dark:bg-gray-900 dark:shadow-gray-900">
          <div className="flex items-center mb-4">
            <Calendar className="text-blue-600 dark:text-blue-400" size={24} />
            <h2 className="text-xl font-semibold text-gray-800 ml-2 dark:text-white">Today's Sessions</h2>
          </div>
          <div className="text-center py-8">
            <div className="text-4xl mb-4">📚</div>
            <h3 className="text-xl font-semibold text-gray-800 mb-2 dark:text-white">No Sessions Planned</h3>
            <p className="text-gray-600 dark:text-gray-300">
              You have no study sessions planned for today. Time to generate a study plan! 🚀
            </p>
          </div>
        </div>
      )}

      {/* Upcoming Study Plans */}
      {upcomingPlans.length > 0 && (
        <div className="bg-white rounded-xl shadow-lg p-6 dark:bg-gray-900 dark:shadow-gray-900">
          <h2 className="text-xl font-semibold text-gray-800 mb-4 flex items-center space-x-2 dark:text-white">
            <BookOpen className="text-purple-600 dark:text-purple-400" size={24} />
            <span>What's Coming Up</span>
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {upcomingPlans
              .filter(plan => plan.plannedTasks && plan.plannedTasks.filter(session => session.status !== 'skipped').length > 0)
              .map((plan) => (
                <div key={plan.id} className="border rounded-lg p-4 dark:bg-gray-800 dark:border-gray-700">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center space-x-2">
                      <h3 className="font-medium text-gray-800 dark:text-white">
                        {new Date(plan.date).toLocaleDateString('en-US', {
                          weekday: 'long',
                          month: 'short',
                          day: 'numeric'
                        })}
                      </h3>
                      {plan.isLocked && (
                        <span className="inline-flex items-center px-1.5 py-0.5 text-xs bg-red-100 text-red-800 rounded-full dark:bg-red-900 dark:text-red-300">
                          <Lock size={10} className="mr-1" />
                          Locked
                        </span>
                      )}
                      <button 
                        onClick={() => handleToggleDayLock(plan.date, plan.isLocked || false)}
                        className={`p-1 rounded transition-colors duration-200 ${
                          plan.isLocked 
                            ? 'bg-red-100 hover:bg-red-200 dark:bg-red-900 dark:hover:bg-red-800' 
                            : 'bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600'
                        }`}
                        title={plan.isLocked ? "Unlock day - Allow changes to this day's sessions" : "Lock day - Protect this day's sessions from changes"}
                      >
                        {plan.isLocked ? (
                          <Lock className="text-red-600 dark:text-red-400" size={14} />
                        ) : (
                          <Unlock className="text-gray-600 dark:text-gray-400" size={14} />
                        )}
                      </button>
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-sm text-gray-500 dark:text-gray-300">
                        {formatTime(plan.plannedTasks
                          .filter(session => session.status !== 'skipped')
                          .reduce((sum, session) => sum + session.allocatedHours, 0)
                        )} of work
                      </span>
                      {plan.isOverloaded && (
                        <span className="px-2 py-1 text-xs bg-yellow-100 text-yellow-800 rounded-full dark:bg-yellow-900 dark:text-yellow-300">
                          Packed!
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    {plan.plannedTasks
                      .filter(session => session.status !== 'skipped') // Hide skipped sessions from upcoming plans
                      .map((session, index) => {
                      const task = getTaskById(session.taskId);
                      if (!task) return null;
                      const sessionStatus = checkSessionStatus(session, plan.date);
                      const isRescheduled = sessionStatus === 'rescheduled';

                      return (
                        <div
                          key={`upcoming-${session.taskId}-${session.sessionNumber || 0}-${session.startTime || ''}-${plan.date}`}
                          className={`flex items-center justify-between p-2 rounded ${
                            isRescheduled 
                              ? 'bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800' 
                              : 'bg-gray-50 dark:bg-gray-900'
                          }`}
                        >
                          <div className="flex items-center space-x-2">
                            <span className={`text-sm font-medium ${
                              isRescheduled 
                                ? 'text-blue-700 dark:text-blue-300' 
                                : 'text-gray-700 dark:text-gray-200'
                            }`}>
                              {task.title}
                            </span>
                            {task.category && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">({task.category})</span>
                    )}
                            {isRescheduled && (
                              <span className="px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded-full dark:bg-blue-900 dark:text-blue-300">
                                Rescheduled
                              </span>
                            )}
                          </div>
                          <div className="flex items-center space-x-2">
                          <div className="flex items-center space-x-2 text-xs text-gray-500 dark:text-gray-300">
                            {editingSessionTime && 
                             editingSessionTime.planDate === plan.date && 
                             editingSessionTime.taskId === session.taskId && 
                             editingSessionTime.sessionNumber === session.sessionNumber ? (
                              <div className="flex items-center space-x-2">
                                <input
                                  type="time"
                                  value={editingSessionTime.newStartTime}
                                  onChange={(e) => setEditingSessionTime({
                                    ...editingSessionTime,
                                    newStartTime: e.target.value
                                  })}
                                  className="px-2 py-1 border rounded text-xs dark:bg-gray-700 dark:border-gray-600"
                                />
                                <span>-</span>
                                <input
                                  type="time"
                                  value={editingSessionTime.newEndTime}
                                  onChange={(e) => setEditingSessionTime({
                                    ...editingSessionTime,
                                    newEndTime: e.target.value
                                  })}
                                  className="px-2 py-1 border rounded text-xs dark:bg-gray-700 dark:border-gray-600"
                                />
                                <button
                                  onClick={handleTimeEditSave}
                                  className="p-1 text-green-600 hover:text-green-800 dark:text-green-400"
                                  title="Save time changes"
                                >
                                  <Save size={12} />
                                </button>
                                <button
                                  onClick={handleTimeEditCancel}
                                  className="p-1 text-gray-600 hover:text-gray-800 dark:text-gray-400"
                                  title="Cancel editing"
                                >
                                  <X size={12} />
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center space-x-2">
                                <span>{session.startTime} - {session.endTime}</span>
                                {plan.isLocked && (
                                  <button
                                    onClick={() => handleStartTimeEdit(
                                      plan.date, 
                                      session.taskId, 
                                      session.sessionNumber || 0, 
                                      session.startTime, 
                                      session.endTime
                                    )}
                                    className="p-1 text-blue-600 hover:text-blue-800 dark:text-blue-400 opacity-60 hover:opacity-100"
                                    title="Edit session time (locked day only)"
                                  >
                                    <Edit size={10} />
                                  </button>
                                )}
                              </div>
                            )}
                            <span>•</span>
                            <span>{formatTime(session.allocatedHours)}</span>
                            {isRescheduled && session.originalTime && (
                              <span className="text-blue-600 dark:text-blue-400">
                                (from {session.originalTime})
                              </span>
                            )}
                            </div>
                            {/* Skip button for rescheduled sessions */}
                            {isRescheduled && session.originalTime && (
                              <button
                                onClick={e => { 
                                  e.stopPropagation(); 
                                  onSkipMissedSession(plan.date, session.sessionNumber || 0, session.taskId);
                                }}
                                className="px-3 py-1 text-xs bg-yellow-100 text-yellow-800 rounded-lg hover:bg-yellow-200 transition-colors duration-200 dark:bg-yellow-900 dark:text-yellow-200 dark:hover:bg-yellow-800"
                                title="Skip this rescheduled session"
                              >
                                Skip
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {studyPlans.length === 0 && (
        <div className="bg-white rounded-xl shadow-lg p-6 text-center dark:bg-gray-900 dark:shadow-gray-900">
          <BookOpen size={48} className="mx-auto mb-4 text-gray-300 dark:text-gray-700" />
          <h2 className="text-xl font-semibold text-gray-800 mb-2 dark:text-white">Ready to Get Started?</h2>
          <p className="text-gray-500 dark:text-gray-300">Add some tasks and I'll create your perfect study schedule! 🎯</p>
        </div>
      )}
    </div>
  );
};

export default StudyPlanView;
