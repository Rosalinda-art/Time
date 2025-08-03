import React, { useState, useEffect } from 'react';
import { Calendar, Clock, Play, CheckCircle2, SkipForward, RotateCcw, AlertTriangle, Lock, Unlock, Info, Lightbulb, Zap, Target, TrendingUp, X } from 'lucide-react';
import { StudyPlan, StudySession, Task, UserSettings, FixedCommitment } from '../types';
import { 
  formatTime, 
  checkSessionStatus, 
  redistributeMissedSessionsWithFeedback, 
  combineSessionsOnSameDay,
  canLockDay,
  lockDay,
  unlockDay,
  calculateRemainingTaskHours,
  getLockedHoursForTask
} from '../utils/scheduling';
import SuggestionsPanel from './SuggestionsPanel';

interface StudyPlanViewProps {
  studyPlans: StudyPlan[];
  tasks: Task[];
  fixedCommitments: FixedCommitment[];
  settings: UserSettings;
  onSelectTask: (task: Task, session?: { allocatedHours: number; planDate?: string; sessionNumber?: number }) => void;
  onGenerateStudyPlan: () => void;
  onUpdateStudyPlans: (plans: StudyPlan[]) => void;
  onSkipMissedSession: (planDate: string, sessionNumber: number, taskId: string) => void;
  onRedistributeMissedSessions: () => void;
}

const StudyPlanView: React.FC<StudyPlanViewProps> = ({
  studyPlans,
  tasks,
  fixedCommitments,
  settings,
  onSelectTask,
  onGenerateStudyPlan,
  onUpdateStudyPlans,
  onSkipMissedSession,
  onRedistributeMissedSessions
}) => {
  const [notificationMessage, setNotificationMessage] = useState<string | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [redistributionInProgress, setRedistributionInProgress] = useState(false);

  const today = new Date().toISOString().split('T')[0];
  const todaysPlan = studyPlans.find(plan => plan.date === today);
  const upcomingPlans = studyPlans.filter(plan => plan.date > today).slice(0, 7);

  // Calculate missed sessions
  const missedSessions = studyPlans
    .filter(plan => plan.date < today)
    .flatMap(plan => 
      plan.plannedTasks
        .filter(session => checkSessionStatus(session, plan.date) === 'missed')
        .map(session => ({
          planDate: plan.date,
          session,
          task: tasks.find(t => t.id === session.taskId)!
        }))
    )
    .filter(item => item.task);

  const handleLockDay = (date: string) => {
    const plan = studyPlans.find(p => p.date === date);
    
    if (plan?.isLocked) {
      // Unlock the day
      const success = unlockDay(date, studyPlans, settings);
      if (success) {
        onUpdateStudyPlans([...studyPlans]); // Trigger re-render
        setNotificationMessage(`Day ${date} unlocked. You can now modify sessions on this day.`);
      }
    } else {
      // Try to lock the day
      const lockCheck = canLockDay(date, studyPlans);
      
      if (lockCheck.canLock) {
        const success = lockDay(date, studyPlans, settings);
        if (success) {
          onUpdateStudyPlans([...studyPlans]); // Trigger re-render
          setNotificationMessage(`Day ${date} locked. Sessions on this day are now protected from changes.`);
        }
      } else {
        setNotificationMessage(`Cannot lock day ${date}: ${lockCheck.reason}`);
      }
    }
  };

  const handleSkipSession = (planDate: string, sessionNumber: number, taskId: string) => {
    onSkipMissedSession(planDate, sessionNumber, taskId);
    setNotificationMessage('Session skipped successfully!');
  };

  const handleRedistributeMissedSessions = async () => {
    setRedistributionInProgress(true);
    try {
      const result = await redistributeMissedSessionsWithFeedback(
        studyPlans,
        settings,
        fixedCommitments,
        tasks
      );
      
      if (result.success) {
        onUpdateStudyPlans(result.updatedPlans);
        setNotificationMessage(`Successfully redistributed ${result.redistributedCount} sessions!`);
      } else {
        setNotificationMessage(`Redistribution completed with issues: ${result.message}`);
      }
    } catch (error) {
      setNotificationMessage('Failed to redistribute sessions. Please try again.');
    } finally {
      setRedistributionInProgress(false);
    }
  };

  const handleCombineSessions = (date: string) => {
    const updatedPlans = combineSessionsOnSameDay(studyPlans, date);
    onUpdateStudyPlans(updatedPlans);
    setNotificationMessage('Sessions combined successfully!');
  };

  useEffect(() => {
    if (notificationMessage) {
      const timer = setTimeout(() => setNotificationMessage(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [notificationMessage]);

  return (
    <div className="space-y-6">
      {/* Notification */}
      {notificationMessage && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center justify-between dark:bg-blue-900/20 dark:border-blue-800">
          <div className="flex items-center space-x-2">
            <Info className="text-blue-600 dark:text-blue-400" size={20} />
            <span className="text-blue-800 dark:text-blue-200">{notificationMessage}</span>
          </div>
          <button
            onClick={() => setNotificationMessage(null)}
            className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-200"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Missed Sessions Alert */}
      {missedSessions.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 dark:bg-red-900/20 dark:border-red-800">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center space-x-2">
              <AlertTriangle className="text-red-600 dark:text-red-400" size={20} />
              <h3 className="text-lg font-semibold text-red-800 dark:text-red-200">
                Missed Sessions ({missedSessions.length})
              </h3>
            </div>
            <div className="flex space-x-2">
              <button
                onClick={handleRedistributeMissedSessions}
                disabled={redistributionInProgress}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {redistributionInProgress ? 'Redistributing...' : 'Redistribute All'}
              </button>
            </div>
          </div>
          
          <div className="space-y-2">
            {missedSessions.map(({ planDate, session, task }, index) => (
              <div key={index} className="flex items-center justify-between bg-white dark:bg-gray-800 rounded-lg p-3 border border-red-200 dark:border-red-700">
                <div className="flex items-center space-x-3">
                  <div className="flex-shrink-0">
                    <div className="w-3 h-3 bg-red-500 rounded-full"></div>
                  </div>
                  <div>
                    <div className="font-medium text-gray-900 dark:text-white">{task.title}</div>
                    <div className="text-sm text-gray-500 dark:text-gray-400">
                      {planDate} • {session.startTime} - {session.endTime} • {formatTime(session.allocatedHours)}
                    </div>
                  </div>
                </div>
                <div className="flex space-x-2">
                  <button
                    onClick={() => onSelectTask(task, { 
                      allocatedHours: session.allocatedHours, 
                      planDate, 
                      sessionNumber: session.sessionNumber 
                    })}
                    className="px-3 py-1 bg-green-100 text-green-800 rounded-lg hover:bg-green-200 transition-colors dark:bg-green-900 dark:text-green-200 dark:hover:bg-green-800"
                  >
                    <Play size={14} className="inline mr-1" />
                    Start Now
                  </button>
                  <button
                    onClick={() => handleSkipSession(planDate, session.sessionNumber || 0, task.id)}
                    className="px-3 py-1 bg-yellow-100 text-yellow-800 rounded-lg hover:bg-yellow-200 transition-colors dark:bg-yellow-900 dark:text-yellow-200 dark:hover:bg-yellow-800"
                  >
                    <SkipForward size={14} className="inline mr-1" />
                    Skip
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Today's Plan */}
      {todaysPlan && (
        <div className="bg-white rounded-xl shadow-lg p-6 dark:bg-gray-900">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center space-x-3">
              <Calendar className="text-blue-600 dark:text-blue-400" size={24} />
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Today's Plan</h2>
              {todaysPlan.isLocked && (
                <span className="inline-flex items-center px-2 py-1 text-xs bg-yellow-100 text-yellow-800 rounded-full dark:bg-yellow-900 dark:text-yellow-200">
                  <Lock size={12} className="mr-1" />
                  Locked
                </span>
              )}
            </div>
            <div className="flex items-center space-x-2">
              <button
                onClick={() => setShowSuggestions(!showSuggestions)}
                className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700"
                title="Show suggestions"
              >
                <Lightbulb size={20} />
              </button>
              <button
                onClick={() => handleLockDay(todaysPlan.date)}
                className={`p-2 rounded-lg transition-colors ${
                  todaysPlan.isLocked
                    ? 'text-yellow-600 bg-yellow-100 hover:bg-yellow-200 dark:bg-yellow-900 dark:text-yellow-300 dark:hover:bg-yellow-800'
                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700'
                }`}
                title={todaysPlan.isLocked ? 'Unlock day (allow modifications)' : 'Lock day (prevent modifications)'}
              >
                {todaysPlan.isLocked ? <Unlock size={16} /> : <Lock size={16} />}
              </button>
            </div>
          </div>

          {showSuggestions && (
            <div className="mb-6">
              <SuggestionsPanel 
                studyPlans={studyPlans}
                tasks={tasks}
                settings={settings}
                onClose={() => setShowSuggestions(false)}
              />
            </div>
          )}

          <div className="space-y-3">
            {todaysPlan.plannedTasks.map((session, index) => {
              const task = tasks.find(t => t.id === session.taskId);
              if (!task) return null;

              const sessionStatus = checkSessionStatus(session, todaysPlan.date);
              const isCompleted = session.status === 'completed';
              const isMissed = sessionStatus === 'missed';

              return (
                <div
                  key={index}
                  className={`p-4 rounded-lg border-l-4 transition-all duration-200 ${
                    isCompleted
                      ? 'bg-green-50 border-l-green-500 dark:bg-green-900/20 dark:border-l-green-400'
                      : isMissed
                      ? 'bg-red-50 border-l-red-500 dark:bg-red-900/20 dark:border-l-red-400'
                      : 'bg-gray-50 border-l-blue-500 hover:bg-gray-100 cursor-pointer dark:bg-gray-800 dark:border-l-blue-400 dark:hover:bg-gray-700'
                  }`}
                  onClick={() => !isCompleted && !isMissed && onSelectTask(task, {
                    allocatedHours: session.allocatedHours,
                    planDate: todaysPlan.date,
                    sessionNumber: session.sessionNumber
                  })}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      <div className={`flex-shrink-0 ${
                        isCompleted ? 'text-green-600 dark:text-green-400' :
                        isMissed ? 'text-red-600 dark:text-red-400' :
                        'text-blue-600 dark:text-blue-400'
                      }`}>
                        {isCompleted ? <CheckCircle2 size={20} /> :
                         isMissed ? <AlertTriangle size={20} /> :
                         <Clock size={20} />}
                      </div>
                      <div>
                        <h3 className={`font-semibold ${
                          isCompleted ? 'text-green-800 line-through dark:text-green-200' :
                          isMissed ? 'text-red-800 dark:text-red-200' :
                          'text-gray-900 dark:text-white'
                        }`}>
                          {task.title}
                        </h3>
                        <div className="flex items-center space-x-4 text-sm text-gray-500 dark:text-gray-400">
                          <span>{session.startTime} - {session.endTime}</span>
                          <span>{formatTime(session.allocatedHours)}</span>
                          {task.category && <span>• {task.category}</span>}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2">
                      {isCompleted && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            // Handle undo completion
                          }}
                          className="px-3 py-1 text-xs bg-orange-100 text-orange-800 rounded-lg hover:bg-orange-200 transition-colors dark:bg-orange-900 dark:text-orange-200 dark:hover:bg-orange-800"
                        >
                          <RotateCcw size={12} className="inline mr-1" />
                          Undo
                        </button>
                      )}
                      {!isCompleted && !isMissed && (
                        <span className={`px-2 py-1 text-xs rounded-full ${
                          task.importance 
                            ? 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200'
                            : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
                        }`}>
                          {task.importance ? 'Important' : 'Regular'}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Upcoming Plans */}
      {upcomingPlans.length > 0 && (
        <div className="bg-white rounded-xl shadow-lg p-6 dark:bg-gray-900">
          <h2 className="text-2xl font-bold text-gray-900 mb-6 flex items-center space-x-2 dark:text-white">
            <Target className="text-purple-600 dark:text-purple-400" size={24} />
            <span>Upcoming Plans</span>
          </h2>

          <div className="space-y-6">
            {upcomingPlans.map((plan) => (
              <div key={plan.id} className="border border-gray-200 rounded-lg p-4 dark:border-gray-700">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center space-x-2">
                    <Calendar className="text-blue-600 dark:text-blue-400" size={20} />
                    <h3 className="text-lg font-semibold text-gray-800 dark:text-white">
                      {new Date(plan.date).toLocaleDateString('en-US', { 
                        weekday: 'long', 
                        month: 'short', 
                        day: 'numeric' 
                      })}
                    </h3>
                    <span className="text-sm text-gray-500 dark:text-gray-400">
                      ({formatTime(plan.totalStudyHours)} planned)
                    </span>
                    {plan.isLocked && (
                      <span className="inline-flex items-center px-2 py-1 text-xs bg-yellow-100 text-yellow-800 rounded-full dark:bg-yellow-900 dark:text-yellow-200">
                        <Lock size={12} className="mr-1" />
                        Locked
                      </span>
                    )}
                  </div>
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => handleLockDay(plan.date)}
                      className={`p-2 rounded-lg transition-colors ${
                        plan.isLocked
                          ? 'text-yellow-600 bg-yellow-100 hover:bg-yellow-200 dark:bg-yellow-900 dark:text-yellow-300 dark:hover:bg-yellow-800'
                          : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700'
                      }`}
                      title={plan.isLocked ? 'Unlock day (allow modifications)' : 'Lock day (prevent modifications)'}
                    >
                      {plan.isLocked ? <Unlock size={16} /> : <Lock size={16} />}
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {plan.plannedTasks.map((session, sessionIndex) => {
                    const task = tasks.find(t => t.id === session.taskId);
                    if (!task) return null;

                    return (
                      <div
                        key={sessionIndex}
                        className="flex items-center justify-between p-3 bg-gray-50 rounded-lg dark:bg-gray-800"
                      >
                        <div className="flex items-center space-x-2">
                          <Clock className="text-gray-500 dark:text-gray-400" size={16} />
                          <div>
                            <div className="font-medium text-gray-900 dark:text-white text-sm">
                              {task.title}
                            </div>
                            <div className="text-xs text-gray-500 dark:text-gray-400">
                              {session.startTime} - {session.endTime}
                            </div>
                          </div>
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {formatTime(session.allocatedHours)}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-4 flex justify-end">
                  <button
                    onClick={() => handleCombineSessions(plan.date)}
                    className="px-3 py-1 text-sm bg-blue-100 text-blue-800 rounded-lg hover:bg-blue-200 transition-colors dark:bg-blue-900 dark:text-blue-200 dark:hover:bg-blue-800"
                  >
                    <Zap size={14} className="inline mr-1" />
                    Combine Sessions
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty State */}
      {studyPlans.length === 0 && (
        <div className="bg-white rounded-xl shadow-lg p-12 text-center dark:bg-gray-900">
          <Calendar size={64} className="mx-auto mb-4 text-gray-300 dark:text-gray-600" />
          <h2 className="text-2xl font-bold text-gray-900 mb-2 dark:text-white">No Study Plans Yet</h2>
          <p className="text-gray-600 mb-6 dark:text-gray-400">
            Create your first study plan to get started with organized learning.
          </p>
          <button
            onClick={onGenerateStudyPlan}
            className="px-6 py-3 bg-gradient-to-r from-blue-600 to-purple-600 text-white rounded-lg hover:from-blue-700 hover:to-purple-700 transition-colors font-semibold"
          >
            Generate Study Plan
          </button>
        </div>
      )}
    </div>
  );
};

export default StudyPlanView;