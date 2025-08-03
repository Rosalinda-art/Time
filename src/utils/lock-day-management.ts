import { StudyPlan, StudySession, Task, UserSettings, FixedCommitment } from '../types';
import { getLocalDateString } from './scheduling';

/**
 * Enhanced Lock Day Management System
 * Provides comprehensive validation and handling for locked days
 */

export interface LockDayValidationResult {
  canLock: boolean;
  warnings: string[];
  blockers: string[];
  affectedSessions: StudySession[];
  alternativeSlots?: Array<{ date: string; reason: string }>;
}

export interface RedistributionContext {
  lockedDaySessions: Map<string, StudySession[]>;
  availableRedistributionDays: string[];
  redistributionPressure: 'low' | 'medium' | 'high';
}

/**
 * Validates whether a day can be safely locked
 */
export const validateDayLock = (
  date: string,
  studyPlans: StudyPlan[],
  tasks: Task[],
  settings: UserSettings,
  fixedCommitments: FixedCommitment[]
): LockDayValidationResult => {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const affectedSessions: StudySession[] = [];
  
  const targetPlan = studyPlans.find(p => p.date === date);
  if (!targetPlan) {
    return {
      canLock: true,
      warnings: [],
      blockers: [],
      affectedSessions: []
    };
  }

  const plannedSessions = targetPlan.plannedTasks || [];
  affectedSessions.push(...plannedSessions);

  // Check 1: Critical deadline sessions
  const criticalSessions = plannedSessions.filter(session => {
    const task = tasks.find(t => t.id === session.taskId);
    if (!task) return false;
    
    const daysUntilDeadline = (new Date(task.deadline).getTime() - new Date(date).getTime()) / (1000 * 60 * 60 * 24);
    return daysUntilDeadline <= 2 && task.importance;
  });

  if (criticalSessions.length > 0) {
    blockers.push(`Cannot lock day with ${criticalSessions.length} critical session(s) within 2 days of deadline`);
  }

  // Check 2: One-time tasks that cannot be redistributed
  const oneTimeSessions = plannedSessions.filter(session => {
    const task = tasks.find(t => t.id === session.taskId);
    return task?.isOneTimeTask;
  });

  if (oneTimeSessions.length > 0) {
    warnings.push(`Day contains ${oneTimeSessions.length} one-time task(s) that may be difficult to reschedule`);
  }

  // Check 3: Redistribution capacity analysis
  const redistributionAnalysis = analyzeRedistributionCapacity(
    date, plannedSessions, studyPlans, tasks, settings
  );

  if (redistributionAnalysis.redistributionPressure === 'high') {
    warnings.push('High redistribution pressure - limited alternative slots available');
  }

  // Check 4: Weekend lock warnings
  const dayOfWeek = new Date(date).getDay();
  if ((dayOfWeek === 0 || dayOfWeek === 6) && plannedSessions.length > 0) {
    warnings.push('Locking weekend days may reduce weekly study capacity');
  }

  return {
    canLock: blockers.length === 0,
    warnings,
    blockers,
    affectedSessions,
    alternativeSlots: redistributionAnalysis.availableRedistributionDays.map(d => ({
      date: d,
      reason: 'Available for redistribution'
    }))
  };
};

/**
 * Analyzes redistribution capacity for sessions from a locked day
 */
const analyzeRedistributionCapacity = (
  lockedDate: string,
  sessionsToRedistribute: StudySession[],
  studyPlans: StudyPlan[],
  tasks: Task[],
  settings: UserSettings
): RedistributionContext => {
  const totalHoursToRedistribute = sessionsToRedistribute.reduce(
    (sum, session) => sum + session.allocatedHours, 0
  );

  const today = getLocalDateString();
  const nextTwoWeeks = Array.from({length: 14}, (_, i) => {
    const date = new Date(today);
    date.setDate(date.getDate() + i + 1);
    return date.toISOString().split('T')[0];
  });

  const availableRedistributionDays = nextTwoWeeks.filter(date => {
    const dayOfWeek = new Date(date).getDay();
    if (!settings.workDays.includes(dayOfWeek)) return false;

    const existingPlan = studyPlans.find(p => p.date === date);
    if (existingPlan?.isLocked) return false;

    const currentLoad = existingPlan ? 
      existingPlan.plannedTasks.reduce((sum, s) => sum + s.allocatedHours, 0) : 0;
    
    return currentLoad < settings.dailyAvailableHours;
  });

  const totalAvailableCapacity = availableRedistributionDays.reduce((sum, date) => {
    const existingPlan = studyPlans.find(p => p.date === date);
    const currentLoad = existingPlan ? 
      existingPlan.plannedTasks.reduce((sum, s) => sum + s.allocatedHours, 0) : 0;
    return sum + (settings.dailyAvailableHours - currentLoad);
  }, 0);

  let redistributionPressure: 'low' | 'medium' | 'high' = 'low';
  if (totalHoursToRedistribute > totalAvailableCapacity * 0.8) {
    redistributionPressure = 'high';
  } else if (totalHoursToRedistribute > totalAvailableCapacity * 0.5) {
    redistributionPressure = 'medium';
  }

  return {
    lockedDaySessions: new Map([[lockedDate, sessionsToRedistribute]]),
    availableRedistributionDays,
    redistributionPressure
  };
};

/**
 * Enhanced redistribution logic that properly handles locked days
 */
export const redistributeFromLockedDays = (
  studyPlans: StudyPlan[],
  tasks: Task[],
  settings: UserSettings,
  fixedCommitments: FixedCommitment[]
): {
  success: boolean;
  redistributedSessions: StudySession[];
  failedSessions: Array<{ session: StudySession; reason: string }>;
  modifiedPlans: StudyPlan[];
} => {
  const modifiedPlans = JSON.parse(JSON.stringify(studyPlans)) as StudyPlan[];
  const redistributedSessions: StudySession[] = [];
  const failedSessions: Array<{ session: StudySession; reason: string }> = [];

  // Find all sessions on locked days that need redistribution
  const lockedDaysSessions: Array<{
    session: StudySession;
    originalDate: string;
    task: Task;
    priority: number;
  }> = [];

  modifiedPlans.forEach(plan => {
    if (plan.isLocked && plan.plannedTasks.length > 0) {
      plan.plannedTasks.forEach(session => {
        const task = tasks.find(t => t.id === session.taskId);
        if (task && task.status === 'pending') {
          // Calculate priority for redistribution
          let priority = 0;
          if (task.importance) priority += 1000;
          
          const daysUntilDeadline = (new Date(task.deadline).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24);
          if (daysUntilDeadline <= 1) priority += 500;
          else if (daysUntilDeadline <= 3) priority += 300;
          else if (daysUntilDeadline <= 7) priority += 200;

          lockedDaysSessions.push({
            session,
            originalDate: plan.date,
            task,
            priority
          });
        }
      });
    }
  });

  // Sort by priority (highest first)
  lockedDaysSessions.sort((a, b) => b.priority - a.priority);

  // Redistribute each session
  for (const { session, originalDate, task } of lockedDaysSessions) {
    const redistributionResult = findBestRedistributionSlot(
      session,
      task,
      modifiedPlans,
      settings,
      fixedCommitments,
      originalDate
    );

    if (redistributionResult.success && redistributionResult.targetDate) {
      // Remove from locked day
      const originalPlan = modifiedPlans.find(p => p.date === originalDate);
      if (originalPlan) {
        const sessionIndex = originalPlan.plannedTasks.findIndex(
          s => s.taskId === session.taskId && s.sessionNumber === session.sessionNumber
        );
        if (sessionIndex !== -1) {
          originalPlan.plannedTasks.splice(sessionIndex, 1);
          originalPlan.totalStudyHours -= session.allocatedHours;
        }
      }

      // Add to new day
      let targetPlan = modifiedPlans.find(p => p.date === redistributionResult.targetDate);
      if (!targetPlan) {
        targetPlan = {
          id: `plan-${redistributionResult.targetDate}`,
          date: redistributionResult.targetDate,
          plannedTasks: [],
          totalStudyHours: 0,
          availableHours: settings.dailyAvailableHours
        };
        modifiedPlans.push(targetPlan);
      }

      const redistributedSession = {
        ...session,
        startTime: redistributionResult.startTime!,
        endTime: redistributionResult.endTime!,
        originalDate: originalDate,
        originalTime: session.startTime,
        status: 'rescheduled' as const
      };

      targetPlan.plannedTasks.push(redistributedSession);
      targetPlan.totalStudyHours += redistributedSession.allocatedHours;
      redistributedSessions.push(redistributedSession);

    } else {
      failedSessions.push({
        session,
        reason: redistributionResult.reason || 'No available slots found'
      });
    }
  }

  return {
    success: redistributedSessions.length > 0,
    redistributedSessions,
    failedSessions,
    modifiedPlans
  };
};

/**
 * Finds the best slot for redistributing a session from a locked day
 */
const findBestRedistributionSlot = (
  session: StudySession,
  task: Task,
  studyPlans: StudyPlan[],
  settings: UserSettings,
  fixedCommitments: FixedCommitment[],
  originalDate: string
): {
  success: boolean;
  targetDate?: string;
  startTime?: string;
  endTime?: string;
  reason?: string;
} => {
  const today = getLocalDateString();
  const deadline = new Date(task.deadline);
  if (settings.bufferDays > 0) {
    deadline.setDate(deadline.getDate() - settings.bufferDays);
  }
  const deadlineStr = deadline.toISOString().split('T')[0];

  // Look for slots in the next 14 days or until deadline
  for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
    const targetDate = new Date(today);
    targetDate.setDate(targetDate.getDate() + dayOffset);
    const targetDateStr = targetDate.toISOString().split('T')[0];

    // Skip if past deadline
    if (targetDateStr > deadlineStr) break;

    // Skip non-work days
    if (!settings.workDays.includes(targetDate.getDay())) continue;

    // Skip locked days
    const targetPlan = studyPlans.find(p => p.date === targetDateStr);
    if (targetPlan?.isLocked) continue;

    // Skip original date
    if (targetDateStr === originalDate) continue;

    // Check available capacity
    const existingSessions = targetPlan ? targetPlan.plannedTasks : [];
    const currentLoad = existingSessions.reduce((sum, s) => sum + s.allocatedHours, 0);
    
    if (currentLoad + session.allocatedHours > settings.dailyAvailableHours) {
      continue;
    }

    // Find time slot using existing logic
    const timeSlot = findAvailableTimeSlot(
      session.allocatedHours,
      existingSessions,
      fixedCommitments,
      settings,
      targetDateStr
    );

    if (timeSlot) {
      return {
        success: true,
        targetDate: targetDateStr,
        startTime: timeSlot.start,
        endTime: timeSlot.end
      };
    }
  }

  return {
    success: false,
    reason: 'No available slots found within deadline'
  };
};

/**
 * Helper function to find available time slots
 */
const findAvailableTimeSlot = (
  requiredHours: number,
  existingSessions: StudySession[],
  fixedCommitments: FixedCommitment[],
  settings: UserSettings,
  date: string
): { start: string; end: string } | null => {
  const busyIntervals: Array<{ start: number; end: number }> = [];
  
  // Add existing sessions
  existingSessions.forEach(session => {
    const [startHour, startMin] = session.startTime.split(':').map(Number);
    const [endHour, endMin] = session.endTime.split(':').map(Number);
    busyIntervals.push({
      start: startHour * 60 + (startMin || 0),
      end: endHour * 60 + (endMin || 0)
    });
  });

  // Add commitments for this day
  const dayOfWeek = new Date(date).getDay();
  fixedCommitments.forEach(commitment => {
    let appliesToDate = false;
    if (commitment.recurring && commitment.daysOfWeek.includes(dayOfWeek)) {
      appliesToDate = true;
    } else if (!commitment.recurring && commitment.specificDates?.includes(date)) {
      appliesToDate = true;
    }

    if (appliesToDate && !commitment.deletedOccurrences?.includes(date)) {
      const modified = commitment.modifiedOccurrences?.[date];
      const startTime = modified?.startTime || commitment.startTime;
      const endTime = modified?.endTime || commitment.endTime;
      
      const [startHour, startMin] = startTime.split(':').map(Number);
      const [endHour, endMin] = endTime.split(':').map(Number);
      
      busyIntervals.push({
        start: startHour * 60 + (startMin || 0),
        end: endHour * 60 + (endMin || 0)
      });
    }
  });

  // Sort intervals
  busyIntervals.sort((a, b) => a.start - b.start);

  // Find available slot
  const requiredMinutes = Math.ceil(requiredHours * 60);
  let currentTime = settings.studyWindowStartHour * 60;
  const endOfDay = settings.studyWindowEndHour * 60;

  for (const interval of busyIntervals) {
    if (interval.start - currentTime >= requiredMinutes) {
      const startHour = Math.floor(currentTime / 60);
      const startMin = currentTime % 60;
      const endTime = currentTime + requiredMinutes;
      const endHour = Math.floor(endTime / 60);
      const endMinute = endTime % 60;
      
      return {
        start: `${startHour.toString().padStart(2, '0')}:${startMin.toString().padStart(2, '0')}`,
        end: `${endHour.toString().padStart(2, '0')}:${endMinute.toString().padStart(2, '0')}`
      };
    }
    currentTime = Math.max(currentTime, interval.end);
  }

  // Check final slot
  if (endOfDay - currentTime >= requiredMinutes) {
    const startHour = Math.floor(currentTime / 60);
    const startMin = currentTime % 60;
    const endTime = currentTime + requiredMinutes;
    const endHour = Math.floor(endTime / 60);
    const endMinute = endTime % 60;
    
    return {
      start: `${startHour.toString().padStart(2, '0')}:${startMin.toString().padStart(2, '0')}`,
      end: `${endHour.toString().padStart(2, '0')}:${endMinute.toString().padStart(2, '0')}`
    };
  }

  return null;
};

/**
 * Mode-specific lock day handlers
 */
export const getLockDayHandlerForMode = (mode: 'even' | 'balanced' | 'eisenhower') => {
  switch (mode) {
    case 'even':
      return {
        shouldSkipRedistribution: (plan: StudyPlan) => plan.isLocked,
        redistributionStrategy: 'even_distribution',
        priority: 'preserve_even_spread'
      };
    case 'balanced':
      return {
        shouldSkipRedistribution: (plan: StudyPlan) => plan.isLocked,
        redistributionStrategy: 'priority_aware',
        priority: 'maintain_task_priorities'
      };
    case 'eisenhower':
      return {
        shouldSkipRedistribution: (plan: StudyPlan) => plan.isLocked,
        redistributionStrategy: 'urgency_importance',
        priority: 'urgent_important_first'
      };
    default:
      return {
        shouldSkipRedistribution: (plan: StudyPlan) => plan.isLocked,
        redistributionStrategy: 'even_distribution',
        priority: 'preserve_even_spread'
      };
  }
};
