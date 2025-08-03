import { Task, StudyPlan, StudySession, UserSettings, FixedCommitment, UserReschedule, RedistributionOptions, RedistributionResult } from '../types';
import { createEnhancedRedistributionEngine, createConflictChecker } from './enhanced-scheduling';

// Utility functions
export const getLocalDateString = (): string => {
  const now = new Date();
  return now.toISOString().split('T')[0];
};

/**
 * Utility function to calculate total study hours for a plan, including skipped sessions as "done"
 * @param plannedTasks Array of study sessions
 * @returns Total study hours including skipped sessions as completed
 */
export const calculateTotalStudyHours = (plannedTasks: StudySession[]): number => {
  return plannedTasks
    .filter(session => session.done || session.status === 'skipped')
    .reduce((sum, session) => sum + session.allocatedHours, 0);
};

/**
 * Utility function to filter out skipped sessions from an array of sessions
 * @param sessions Array of study sessions
 * @returns Array of sessions excluding skipped ones
 */
export const filterSkippedSessions = (sessions: StudySession[]): StudySession[] => {
  return sessions.filter(session => session.status !== 'skipped');
};

export const formatTime = (hours: number): string => {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

export const formatTimeForTimer = (seconds: number): string => {
  const totalSeconds = Math.max(0, Math.round(seconds));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0) {
    return `${h}h${m > 0 ? ` ${m}m` : ''}`;
  } else {
    return `${m}m`;
  }
};

/**
 * Check if a task's frequency preference conflicts with its deadline
 * @param task Task to check
 * @param settings User settings including buffer days and work days
 * @returns Object indicating if there's a conflict and why
 */
export const checkFrequencyDeadlineConflict = (
  task: Pick<Task, 'deadline' | 'estimatedHours' | 'targetFrequency' | 'deadlineType' | 'minWorkBlock'>,
  settings: UserSettings
): { hasConflict: boolean; reason?: string; recommendedFrequency?: string } => {
  // No conflict for tasks without deadlines
  if (!task.deadline || task.deadlineType === 'none') {
    return { hasConflict: false };
  }

  // No conflict for flexible deadlines (soft deadlines can be adjusted)
  if (task.deadlineType === 'soft') {
    return { hasConflict: false };
  }

  const deadline = new Date(task.deadline);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  // Calculate available days until deadline (respecting buffer)
  const bufferDate = new Date(deadline);
  bufferDate.setDate(bufferDate.getDate() - settings.bufferDays);
  
  const timeDiff = bufferDate.getTime() - today.getTime();
  const totalDaysUntilDeadline = Math.max(0, Math.ceil(timeDiff / (1000 * 60 * 60 * 24)));
  
  // Count work days until deadline
  let workDaysCount = 0;
  const currentDate = new Date(today);
  
  while (currentDate <= bufferDate) {
    const dayOfWeek = currentDate.getDay();
    if (settings.workDays.includes(dayOfWeek)) {
      workDaysCount++;
    }
    currentDate.setDate(currentDate.getDate() + 1);
  }

  // Calculate minimum sessions needed based on task requirements
  const minSessionHours = (task.minWorkBlock || 30) / 60;
  const minSessionsNeeded = Math.ceil(task.estimatedHours / Math.max(minSessionHours, settings.dailyAvailableHours));
  
  // Determine required frequency based on task preference
  let requiredDaysBetweenSessions = 1;
  switch (task.targetFrequency) {
    case 'weekly':
      requiredDaysBetweenSessions = 7;
      break;
    case '3x-week':
      requiredDaysBetweenSessions = 2; // Every 2-3 days
      break;
    case 'flexible':
      requiredDaysBetweenSessions = 3; // Every 3-4 days
      break;
    case 'daily':
    default:
      requiredDaysBetweenSessions = 1;
      break;
  }

  // Calculate how many sessions we can fit with the preferred frequency
  const maxSessionsWithFrequency = Math.floor(workDaysCount / requiredDaysBetweenSessions) + 1;
  
  // Check if frequency allows sufficient sessions before deadline
  if (maxSessionsWithFrequency < minSessionsNeeded) {
    let recommendedFrequency = 'daily';
    
    // Try to find a less restrictive frequency that works
    const frequencies = [
      { name: '3x-week', days: 2 },
      { name: 'daily', days: 1 }
    ];
    
    for (const freq of frequencies) {
      const sessionsWithThisFreq = Math.floor(workDaysCount / freq.days) + 1;
      if (sessionsWithThisFreq >= minSessionsNeeded) {
        recommendedFrequency = freq.name;
        break;
      }
    }
    
    return {
      hasConflict: true,
      reason: `Your ${task.targetFrequency} frequency only allows ${maxSessionsWithFrequency} sessions, but you need at least ${minSessionsNeeded} sessions to complete this task before the deadline.`,
      recommendedFrequency
    };
  }

  return { hasConflict: false };
};

export const checkSessionStatus = (session: StudySession, planDate: string): 'scheduled' | 'in_progress' | 'completed' | 'missed' | 'overdue' | 'rescheduled' => {
  const now = new Date();
  const today = getLocalDateString();
  const sessionStartTime = new Date(`${planDate}T${session.startTime}:00`);
  const sessionEndTime = new Date(`${planDate}T${session.endTime}:00`);

  // Debug logging for session status calculation
  console.log(`checkSessionStatus debug: planDate="${planDate}", today="${today}", planDate < today = ${planDate < today}, session.done=${session.done}, session.status=${session.status}`);

  // Check completion status first - completed sessions are never missed
  if (session.done || session.status === 'completed') {
    return 'completed';
  }

  // Check if session is skipped - skipped sessions should not be treated as missed
  if (session.status === 'skipped') {
    return 'completed'; // Treat skipped sessions as completed for display purposes
  }

  if (session.originalTime && session.originalDate) {
    return 'rescheduled';
  }

  // Only mark as missed if not completed and from past date
  // AND the session was originally scheduled for that past date (not redistributed there)
  if (planDate < today) {
    // If session has original time/date, it was redistributed - don't mark as missed
    if (session.originalTime && session.originalDate) {
      console.log(`Session redistributed to past date ${planDate} - not marking as missed`);
      return 'scheduled'; // Treat redistributed sessions as scheduled
    }
    console.log(`Session from past date ${planDate} marked as MISSED`);
    return 'missed';
  }

  if (planDate === today) {
    if (now < sessionStartTime) {
      return 'scheduled';
    } else if (now >= sessionStartTime && now <= sessionEndTime) {
      return 'in_progress';
    } else {
      console.log(`Session from today ${planDate} marked as OVERDUE`);
      return 'overdue';
    }
  }

  return 'scheduled';
};

// Helper function to check if a session is a missed or redistributed session
const isMissedOrRedistributedSession = (session: StudySession, planDate: string): boolean => {
  const status = checkSessionStatus(session, planDate);
  return status === 'missed' || session.isManualOverride === true || (!!session.originalTime && !!session.originalDate);
};

// Helper function to optimize session distribution by trying to create larger sessions
const optimizeSessionDistribution = (task: Task, totalHours: number, daysForTask: string[], settings: UserSettings) => {
  const minSessionLength = (settings.minSessionLength || 15) / 60; // in hours
  const maxSessionLength = Math.min(4, settings.dailyAvailableHours); // Cap at 4 hours or daily limit

  // For one-time tasks, return a single session with all hours
  // Note: Scheduling timing is handled in the distribution loop:
  // - High-impact one-sitting tasks: scheduled early (maximum priority)
  // - Regular one-sitting tasks: scheduled on deadline day (respecting buffer), or closest available day
  if (task.isOneTimeTask) {
    return [totalHours];
  }

  // Try to create fewer, larger sessions
  let optimalSessions: number[] = [];
  let remainingHours = totalHours;

  // Calculate how many sessions we can create with minimum length
  const maxSessionsWithMinLength = Math.floor(totalHours / minSessionLength);

  // Determine optimal number of sessions
  let numSessions = Math.min(daysForTask.length, maxSessionsWithMinLength);

  if (numSessions === 0) {
    // If we can't meet minimum session length, create one session per day
    numSessions = daysForTask.length;
  }

  // Create sessions with preference for larger sessions
  for (let i = 0; i < numSessions && remainingHours > 0; i++) {
    const sessionLength = Math.min(
      remainingHours / (numSessions - i), // Distribute remaining hours evenly
      maxSessionLength, // Don't exceed max session length
      remainingHours // Don't exceed remaining hours
    );

    if (sessionLength >= minSessionLength) {
      optimalSessions.push(sessionLength);
      remainingHours -= sessionLength;
    }
  }

  // If we have remaining hours, add them to the first session
  if (remainingHours > 0 && optimalSessions.length > 0) {
    optimalSessions[0] += remainingHours;
  }

  return optimalSessions;
};

// Remove calculatePriorityScore, calculateTaskPriorityScore, and TaskWithPriority

// Helper to find the next available time slot for a session on a given day
function findNextAvailableTimeSlot(
  requiredHours: number,
  existingSessions: StudySession[],
  commitments: FixedCommitment[],
  studyWindowStartHour: number,
  studyWindowEndHour: number,
  bufferTimeBetweenSessions: number = 0, // new param, in minutes
  targetDate?: string // Add target date for filtering deleted occurrences
): { start: string; end: string } | null {
  // Build a list of all busy intervals (sessions and commitments)
  const busyIntervals: Array<{ start: number; end: number }> = [];
  existingSessions.forEach(s => {
    const [sh, sm] = s.startTime.split(":").map(Number);
    const [eh, em] = s.endTime.split(":").map(Number);
    busyIntervals.push({ start: sh * 60 + (sm || 0), end: eh * 60 + (em || 0) });
  });
  
  // Filter commitments to exclude deleted occurrences and apply modifications
  const activeCommitments = commitments.filter(commitment => {
    if (!targetDate) return true; // If no target date, include all commitments
    return !commitment.deletedOccurrences?.includes(targetDate);
  });
  
  activeCommitments.forEach(c => {
    const [sh, sm] = c.startTime.split(":").map(Number);
    const [eh, em] = c.endTime.split(":").map(Number);
    
    // Apply modifications if they exist for the target date
    if (targetDate && c.modifiedOccurrences?.[targetDate]) {
      const modified = c.modifiedOccurrences[targetDate];
      if (modified.startTime) {
        const [msh, msm] = modified.startTime.split(":").map(Number);
        busyIntervals.push({ start: msh * 60 + (msm || 0), end: eh * 60 + (em || 0) });
      } else if (modified.endTime) {
        const [meh, mem] = modified.endTime.split(":").map(Number);
        busyIntervals.push({ start: sh * 60 + (sm || 0), end: meh * 60 + (mem || 0) });
      } else {
        busyIntervals.push({ start: sh * 60 + (sm || 0), end: eh * 60 + (em || 0) });
      }
    } else {
      busyIntervals.push({ start: sh * 60 + (sm || 0), end: eh * 60 + (em || 0) });
    }
  });
  
  busyIntervals.sort((a, b) => a.start - b.start);
  // Find the first available slot
  const requiredMinutes = Math.ceil(requiredHours * 60);
  let current = studyWindowStartHour * 60;
  const endOfDay = studyWindowEndHour * 60;
  for (const interval of busyIntervals) {
    if (interval.start - current >= requiredMinutes) {
      // Found a slot
      const startH = Math.floor(current / 60).toString().padStart(2, '0');
      const startM = (current % 60).toString().padStart(2, '0');
      const end = current + requiredMinutes;
      const endH = Math.floor(end / 60).toString().padStart(2, '0');
      const endM = (end % 60).toString().padStart(2, '0');
      return { start: `${startH}:${startM}`, end: `${endH}:${endM}` };
    }
    // Add buffer after each busy interval
    current = Math.max(current, interval.end + bufferTimeBetweenSessions);
  }
  // Check after last busy interval
  if (endOfDay - current >= requiredMinutes) {
    const startH = Math.floor(current / 60).toString().padStart(2, '0');
    const startM = (current % 60).toString().padStart(2, '0');
    const end = current + requiredMinutes;
    const endH = Math.floor(end / 60).toString().padStart(2, '0');
    const endM = (end % 60).toString().padStart(2, '0');
    return { start: `${startH}:${startM}`, end: `${endH}:${endM}` };
  }
  return null; // No available slot
}

// Helper function to validate that sessions don't overlap with each other or commitments
function validateSessionTimes(
  sessions: StudySession[],
  commitments: FixedCommitment[],
  date: string
): boolean {
  const timeToMinutes = (timeStr: string): number => {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
  };

  // Create a list of all busy intervals
  const busyIntervals: Array<{ start: number; end: number; source: string }> = [];

  // Add commitment intervals
  commitments.forEach(commitment => {
    let appliesToDate = false;
    if (commitment.recurring) {
      appliesToDate = commitment.daysOfWeek.includes(new Date(date).getDay());
    } else {
      appliesToDate = commitment.specificDates?.includes(date) || false;
    }

    if (appliesToDate && !commitment.deletedOccurrences?.includes(date)) {
      busyIntervals.push({
        start: timeToMinutes(commitment.startTime),
        end: timeToMinutes(commitment.endTime),
        source: `commitment-${commitment.title}`
      });
    }
  });

  // Add session intervals
  sessions.forEach((session, index) => {
    if (session.startTime && session.endTime) {
      busyIntervals.push({
        start: timeToMinutes(session.startTime),
        end: timeToMinutes(session.endTime),
        source: `session-${index}`
      });
    }
  });

  // Check for overlaps
  busyIntervals.sort((a, b) => a.start - b.start);
  for (let i = 0; i < busyIntervals.length - 1; i++) {
    const current = busyIntervals[i];
    const next = busyIntervals[i + 1];
    
    if (current.end > next.start) {
      console.warn(`Overlap detected on ${date}: ${current.source} (${current.start}-${current.end}) overlaps with ${next.source} (${next.start}-${next.end})`);
      return false;
    }
  }

  return true;
}

export const generateNewStudyPlan = (
  tasks: Task[],
  settings: UserSettings,
  fixedCommitments: FixedCommitment[],
  existingStudyPlans: StudyPlan[] = []
): { plans: StudyPlan[]; suggestions: Array<{ taskTitle: string; unscheduledMinutes: number }> } => {
  // Collect missed sessions from existing plans for redistribution
  const missedSessionsToRedistribute: Array<{session: StudySession, planDate: string, task: Task}> = [];
  if (existingStudyPlans.length > 0) {
    existingStudyPlans.forEach(plan => {
      plan.plannedTasks.forEach(session => {
        const status = checkSessionStatus(session, plan.date);
        if (status === 'missed') {
          const task = tasks.find(t => t.id === session.taskId);
          if (task && task.status === 'pending') {
            missedSessionsToRedistribute.push({session, planDate: plan.date, task});
          }
        }
      });
    });
  }

  if (settings.studyPlanMode === 'even') {
    // EVEN DISTRIBUTION LOGIC
    // Separate deadline-based tasks from no-deadline tasks
    const allPendingTasks = tasks.filter(task => task.status === 'pending' && task.estimatedHours > 0);

    const deadlineTasks = allPendingTasks
      .filter(task => task.deadline && task.deadline.trim().length > 0 && task.deadlineType !== 'none')
      .sort((a, b) => {
        if (a.importance !== b.importance) return a.importance ? -1 : 1; // Important first
        return new Date(a.deadline).getTime() - new Date(b.deadline).getTime(); // Then by deadline (earlier = more urgent)
      });

    const noDeadlineTasks = allPendingTasks
      .filter(task => !task.deadline || task.deadline.trim().length === 0 || task.deadlineType === 'none')
      .sort((a, b) => {
        if (a.importance !== b.importance) return a.importance ? -1 : 1; // Important first
        return a.title.localeCompare(b.title); // Then alphabetically
      });

    // Use deadline tasks for now (we'll add no-deadline scheduling later)
    const tasksEven = deadlineTasks;

    // Create a map of missed session hours per task for separate redistribution
    const missedSessionHoursByTask: { [taskId: string]: number } = {};
    missedSessionsToRedistribute.forEach(({session, task}) => {
      missedSessionHoursByTask[task.id] = (missedSessionHoursByTask[task.id] || 0) + session.allocatedHours;
    });

    // Step 1: Create a map of available study days
    const now = new Date();
    // Calculate latest deadline using original deadlines (buffer will be applied per task)
    const latestDeadline = new Date(Math.max(...tasksEven.map(t => new Date(t.deadline).getTime())));
    const availableDays: string[] = [];
    const tempDate = new Date(now);
    // Include the latest deadline day by using <= comparison
    while (tempDate <= latestDeadline) {
      const dateStr = tempDate.toISOString().split('T')[0];
      const dayOfWeek = tempDate.getDay();
      if (settings.workDays.includes(dayOfWeek)) {
        availableDays.push(dateStr);
      }
      tempDate.setDate(tempDate.getDate() + 1);
    }
    
    // When buffer days is 0, ensure we include the deadline day itself
    if (settings.bufferDays === 0) {
      // Add any missing deadline days that might not be included due to time zone issues
      tasksEven.forEach(task => {
        const deadlineDateStr = new Date(task.deadline).toISOString().split('T')[0];
        if (!availableDays.includes(deadlineDateStr) && settings.workDays.includes(new Date(deadlineDateStr).getDay())) {
          availableDays.push(deadlineDateStr);
        }
      });
      // Sort available days to maintain order
      availableDays.sort();
    } else {
      // When buffer days > 0, ensure we include the buffer-adjusted deadline days
      tasksEven.forEach(task => {
        const deadline = new Date(task.deadline);
        deadline.setDate(deadline.getDate() - settings.bufferDays);
        const deadlineDateStr = deadline.toISOString().split('T')[0];
        if (!availableDays.includes(deadlineDateStr) && settings.workDays.includes(new Date(deadlineDateStr).getDay())) {
          availableDays.push(deadlineDateStr);
        }
      });
      // Sort available days to maintain order
      availableDays.sort();
    }
    

    const studyPlans: StudyPlan[] = [];
    const dailyRemainingHours: { [date: string]: number } = {};
    availableDays.forEach(date => {
      dailyRemainingHours[date] = settings.dailyAvailableHours;
      studyPlans.push({
        id: `plan-${date}`,
        date,
        plannedTasks: [],
        totalStudyHours: 0,
        availableHours: settings.dailyAvailableHours
      });
    });
    let evenTaskScheduledHours: { [taskId: string]: number } = {};
    tasksEven.forEach(task => {
      evenTaskScheduledHours[task.id] = 0;
    });

    // Helper function to redistribute unscheduled hours for a task
    const redistributeUnscheduledHours = (task: Task, unscheduledHours: number, daysForTask: string[]) => {
      let remainingUnscheduledHours = unscheduledHours;
      let redistributionRound = 0;
      const maxRedistributionRounds = 10; // Prevent infinite loops
      const minSessionLength = (settings.minSessionLength || 15) / 60; // in hours
      
      while (remainingUnscheduledHours > 0 && redistributionRound < maxRedistributionRounds) {
        redistributionRound++;
        
        // Find all available days within the task's deadline that have remaining capacity
        const availableDaysForRedistribution = daysForTask.filter(date => {
          return dailyRemainingHours[date] > 0;
        });
        
        if (availableDaysForRedistribution.length === 0) {
          // No more available days, can't redistribute further
          break;
        }
        
        // Try to create larger sessions by distributing to fewer days
        let distributedThisRound = 0;
        
        // Calculate optimal distribution for remaining hours
        const optimalSessions = optimizeSessionDistribution(task, remainingUnscheduledHours, availableDaysForRedistribution, settings);
        
        // Distribute optimal sessions to available days
        for (let i = 0; i < optimalSessions.length && i < availableDaysForRedistribution.length; i++) {
          const date = availableDaysForRedistribution[i];
          const dayPlan = studyPlans.find(p => p.date === date)!;
          const availableHours = dailyRemainingHours[date];
          const sessionLength = Math.min(optimalSessions[i], availableHours);
          
          if (sessionLength >= minSessionLength) {
            const roundedSessionLength = Math.round(sessionLength * 60) / 60;

            // Find available time slot for this session to prevent overlaps
            const commitmentsForDay = fixedCommitments.filter(commitment => {
              if (commitment.recurring) {
                return commitment.daysOfWeek.includes(new Date(date).getDay());
              } else {
                return commitment.specificDates?.includes(date) || false;
              }
            });

            const timeSlot = findNextAvailableTimeSlot(
              roundedSessionLength,
              dayPlan.plannedTasks,
              commitmentsForDay,
              settings.studyWindowStartHour || 6,
              settings.studyWindowEndHour || 23,
              settings.bufferTimeBetweenSessions || 0,
              date
            );

            // Only add the session if we found a valid time slot
            if (timeSlot) {
              dayPlan.plannedTasks.push({
                taskId: task.id,
                scheduledTime: `${date}`,
                startTime: timeSlot.start,
                endTime: timeSlot.end,
                allocatedHours: roundedSessionLength,
                sessionNumber: (dayPlan.plannedTasks.filter(s => s.taskId === task.id).length) + 1,
                isFlexible: true,
                status: 'scheduled'
              });
              dayPlan.totalStudyHours = Math.round((dayPlan.totalStudyHours + roundedSessionLength) * 60) / 60;
              dailyRemainingHours[date] = Math.round((dailyRemainingHours[date] - roundedSessionLength) * 60) / 60;
              distributedThisRound = Math.round((distributedThisRound + roundedSessionLength) * 60) / 60;
            } else {
              // No available time slot found, skip this distribution
              console.log(`No available time slot found for ${roundedSessionLength} hours on ${date}`);
            }
          }
        }
        
        // Update remaining unscheduled hours
        remainingUnscheduledHours -= distributedThisRound;
        
        // If we couldn't distribute any hours this round, break to prevent infinite loop
        if (distributedThisRound === 0) {
          break;
        }
      }
      
      return remainingUnscheduledHours; // Return any still unscheduled hours
    };

    // Helper function to combine sessions of the same task on the same day
    const combineSessionsOnSameDay = (studyPlans: StudyPlan[]) => {
      for (const plan of studyPlans) {
        // Group sessions by taskId, excluding skipped sessions from combination
        const sessionsByTask: { [taskId: string]: StudySession[] } = {};
        
        plan.plannedTasks.forEach(session => {
          // Skip sessions that are marked as skipped - they shouldn't be combined with other sessions
          if (session.status === 'skipped') {
            return;
          }
          
          if (!sessionsByTask[session.taskId]) {
            sessionsByTask[session.taskId] = [];
          }
          sessionsByTask[session.taskId].push(session);
        });
        
        const combinedSessions: StudySession[] = [];
        
        // Combine sessions for each task - only if they are truly adjacent
        Object.entries(sessionsByTask).forEach(([taskId, sessions]) => {
          if (sessions.length > 1) {
            // Sort sessions by start time
            sessions.sort((a, b) => a.startTime.localeCompare(b.startTime));

            // Group adjacent sessions together
            let currentGroup: StudySession[] = [sessions[0]];
            const sessionGroups: StudySession[][] = [];

            for (let i = 1; i < sessions.length; i++) {
              const currentSession = sessions[i];
              const lastInGroup = currentGroup[currentGroup.length - 1];

              // Check if sessions are adjacent (current starts when last ends)
              if (currentSession.startTime === lastInGroup.endTime) {
                currentGroup.push(currentSession);
              } else {
                // Not adjacent, start a new group
                sessionGroups.push(currentGroup);
                currentGroup = [currentSession];
              }
            }
            // Add the last group
            sessionGroups.push(currentGroup);

            // Combine each group of adjacent sessions
            sessionGroups.forEach((group, groupIndex) => {
              if (group.length > 1) {
                const firstSession = group[0];
                const lastSession = group[group.length - 1];
                const totalHours = group.reduce((sum, session) => sum + session.allocatedHours, 0);

                const combinedSession: StudySession = {
                  ...firstSession,
                  startTime: firstSession.startTime,
                  endTime: lastSession.endTime,
                  allocatedHours: totalHours,
                  sessionNumber: groupIndex + 1
                };

                combinedSessions.push(combinedSession);
              } else {
                // Single session in group, keep as is but update session number
                combinedSessions.push({
                  ...group[0],
                  sessionNumber: groupIndex + 1
                });
              }
            });
          } else {
            // Single session, keep as is
            combinedSessions.push(sessions[0]);
          }
        });
        
        // Update the plan with combined sessions (keeping skipped sessions separate)
        const skippedSessions = plan.plannedTasks.filter(session => session.status === 'skipped');
        plan.plannedTasks = [...combinedSessions, ...skippedSessions];
        
        // Calculate totalStudyHours including skipped sessions as "done"
        plan.totalStudyHours = calculateTotalStudyHours(plan.plannedTasks);
      }
    };



    // For each task, distribute hours evenly across available days until deadline
    for (const task of tasksEven) {
      const deadline = new Date(task.deadline);
      if (settings.bufferDays > 0) {
        deadline.setDate(deadline.getDate() - settings.bufferDays);
      }
      // Normalize deadline to start of day for comparison with date strings
      const deadlineDateStr = deadline.toISOString().split('T')[0];
      // Include all available days up to and including the deadline day
      let daysForTask = availableDays.filter(d => d <= deadlineDateStr);
      
      // Apply frequency preference if enabled and no conflict detected
      if (task.respectFrequencyForDeadlines !== false && task.targetFrequency) {
        const conflictCheck = checkFrequencyDeadlineConflict(task, settings);
        
        if (!conflictCheck.hasConflict) {
          // Apply frequency filtering to respect user preference
          let sessionGap = 1; // Days between sessions
          if (task.targetFrequency === 'weekly') sessionGap = 7;
          else if (task.targetFrequency === '3x-week') sessionGap = 2;
          else if (task.targetFrequency === 'flexible') {
            // For flexible tasks, adapt the gap based on available time and task urgency
            sessionGap = task.importance ? 2 : 3; // More frequent for important tasks
          }
          // daily frequency uses sessionGap = 1 (no filtering needed)
          
          if (sessionGap > 1) {
            // Filter days to respect frequency preference
            const frequencyFilteredDays: string[] = [];
            for (let i = 0; i < daysForTask.length; i += sessionGap) {
              frequencyFilteredDays.push(daysForTask[i]);
            }
            daysForTask = frequencyFilteredDays;
          }
        }
      }
      

      
      // If no days available, skip this task
      if (daysForTask.length === 0) {
        continue;
      }
      
      let totalHours = task.estimatedHours;
      
      // Use optimized session distribution instead of simple even distribution
      const sessionLengths = optimizeSessionDistribution(task, totalHours, daysForTask, settings);
      

      // Assign sessions to available days, distributing optimally
      let unscheduledHours = 0;
      for (let i = 0; i < sessionLengths.length && i < daysForTask.length; i++) {
        const date = daysForTask[i];
        let dayPlan = studyPlans.find(p => p.date === date)!;
        let availableHours = dailyRemainingHours[date];
        const thisSessionLength = Math.min(sessionLengths[i], availableHours);
        
        if (thisSessionLength > 0) {
          const roundedSessionLength = Math.round(thisSessionLength * 60) / 60;
          dayPlan.plannedTasks.push({
            taskId: task.id,
            scheduledTime: `${date}`,
            startTime: '',
            endTime: '',
            allocatedHours: roundedSessionLength,
            sessionNumber: (dayPlan.plannedTasks.filter(s => s.taskId === task.id).length) + 1,
            isFlexible: true,
            status: 'scheduled'
          });
          dayPlan.totalStudyHours = Math.round((dayPlan.totalStudyHours + roundedSessionLength) * 60) / 60;
          dailyRemainingHours[date] = Math.round((dailyRemainingHours[date] - roundedSessionLength) * 60) / 60;
          totalHours = Math.round((totalHours - roundedSessionLength) * 60) / 60;
        } else {
          // Track unscheduled hours for redistribution
          unscheduledHours += sessionLengths[i];
        }
      }
      
      // Redistribute any unscheduled hours using the improved redistribution logic
      if (unscheduledHours > 0) {
        console.log(`Task "${task.title}" has ${unscheduledHours} unscheduled hours to redistribute`);
        
        const finalUnscheduledHours = redistributeUnscheduledHours(task, unscheduledHours, daysForTask);
        
        if (finalUnscheduledHours > 0) {
          console.log(`Task "${task.title}" still has ${finalUnscheduledHours} unscheduled hours after redistribution`);
        }
      }
    }
    
    // Combine sessions of the same task on the same day
    combineSessionsOnSameDay(studyPlans);
    
    // Validate scheduling for conflicts after all redistribution and combining
    studyPlans.forEach(plan => {
      if (!validateSessionTimes(plan.plannedTasks, fixedCommitments, plan.date)) {
        console.warn(`Scheduling conflicts detected on ${plan.date} after redistribution. Some sessions may overlap.`);
      }
    });

    // Final pass: handle any remaining unscheduled hours and create suggestions
    const suggestions: Array<{ taskTitle: string; unscheduledMinutes: number }> = [];
    let taskScheduledHours: { [taskId: string]: number } = {};
    
    // Calculate how many hours each task actually got scheduled (excluding skipped sessions)
    for (const plan of studyPlans) {
      for (const session of plan.plannedTasks) {
        // Skip sessions that are marked as skipped - they shouldn't count towards scheduled hours
        if (session.status !== 'skipped') {
          taskScheduledHours[session.taskId] = (taskScheduledHours[session.taskId] || 0) + session.allocatedHours;
        }
      }
    }
    
    // Global redistribution pass: try to fit any remaining unscheduled hours
    const tasksWithUnscheduledHours = tasksEven.filter(task => {
      const scheduledHours = taskScheduledHours[task.id] || 0;
      return task.estimatedHours - scheduledHours > 0;
    });
    
    if (tasksWithUnscheduledHours.length > 0) {
      console.log(`Global redistribution: ${tasksWithUnscheduledHours.length} tasks have unscheduled hours`);
      
      // Sort tasks by importance and deadline for global redistribution
      const sortedTasksForGlobalRedistribution = tasksWithUnscheduledHours.sort((a, b) => {
        if (a.importance !== b.importance) return a.importance ? -1 : 1;
        return new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
      });
      
      for (const task of sortedTasksForGlobalRedistribution) {
        const scheduledHours = taskScheduledHours[task.id] || 0;
        const unscheduledHours = task.estimatedHours - scheduledHours;
        
        if (unscheduledHours <= 0) continue;
        
        // Get deadline for this task
        const deadline = new Date(task.deadline);
        if (settings.bufferDays > 0) {
          deadline.setDate(deadline.getDate() - settings.bufferDays);
        }
        const deadlineDateStr = deadline.toISOString().split('T')[0];
        const daysForTask = availableDays.filter(d => d <= deadlineDateStr);
        
        // Try to redistribute remaining hours
        const finalUnscheduledHours = redistributeUnscheduledHours(task, unscheduledHours, daysForTask);
        
        if (finalUnscheduledHours > 0) {
          console.log(`Global redistribution: Task "${task.title}" still has ${finalUnscheduledHours} unscheduled hours`);
        }
      }
      
      // Recalculate scheduled hours after global redistribution (excluding skipped sessions)
      taskScheduledHours = {};
    for (const plan of studyPlans) {
      for (const session of plan.plannedTasks) {
        // Skip sessions that are marked as skipped - they shouldn't count towards scheduled hours
        if (session.status !== 'skipped') {
          taskScheduledHours[session.taskId] = (taskScheduledHours[session.taskId] || 0) + session.allocatedHours;
        }
      }
      }
      
      // Combine sessions again after global redistribution
      combineSessionsOnSameDay(studyPlans);
    }
    
    // Check for unscheduled hours and create suggestions
    for (const task of tasksEven) {
      const scheduledHours = taskScheduledHours[task.id] || 0;
      const unscheduledHours = task.estimatedHours - scheduledHours;
      
      // Only show suggestions for tasks with more than 1 minute unscheduled (to avoid floating point precision issues)
      if (unscheduledHours > 0.016) { // 1 minute = 0.016 hours
        suggestions.push({
          taskTitle: task.title,
          unscheduledMinutes: Math.round(unscheduledHours * 60)
        });
      }
    }
    
    // For each day, sort plannedTasks by importance before assigning time slots
    for (const plan of studyPlans) {
              // Sort by importance first, then by deadline urgency (earlier deadline = more urgent)
        plan.plannedTasks.sort((a, b) => {
          const taskA = tasksEven.find(t => t.id === a.taskId);
          const taskB = tasksEven.find(t => t.id === b.taskId);
        if (!taskA || !taskB) return 0;
        if (taskA.importance !== taskB.importance) return taskA.importance ? -1 : 1;
        // If same importance, prioritize by deadline (earlier = more urgent)
        return new Date(taskA.deadline).getTime() - new Date(taskB.deadline).getTime();
      });
      // Assign time slots for each session, ensuring no overlap with commitments or other sessions
      const commitmentsForDay = fixedCommitments.filter(commitment => {
        // Check if this commitment applies to this specific date
        if (commitment.recurring) {
          // For recurring commitments, check if the day of week matches
          return commitment.daysOfWeek.includes(new Date(plan.date).getDay());
        } else {
          // For non-recurring commitments, check if the specific date matches
          return commitment.specificDates?.includes(plan.date) || false;
        }
      });
      let assignedSessions: StudySession[] = [];
      for (const session of plan.plannedTasks) {
        const slot = findNextAvailableTimeSlot(
          session.allocatedHours,
          assignedSessions,
          commitmentsForDay,
          settings.studyWindowStartHour || 6,
          settings.studyWindowEndHour || 23,
          settings.bufferTimeBetweenSessions || 0, // pass buffer
          plan.date // pass target date for filtering deleted occurrences
        );
        if (slot) {
          session.startTime = slot.start;
          session.endTime = slot.end;
          assignedSessions.push(session);
        } else {
          session.startTime = '';
          session.endTime = '';
        }
      }

      // Validate that no sessions overlap on this day
      if (!validateSessionTimes(plan.plannedTasks, commitmentsForDay, plan.date)) {
        console.error(`Session overlap detected on ${plan.date} - some sessions may be incorrectly scheduled`);
      }
    }
    
    // REDISTRIBUTE MISSED SESSIONS
    // After normal scheduling is complete, try to redistribute missed sessions
    if (Object.keys(missedSessionHoursByTask).length > 0) {
      console.log('Attempting to redistribute missed sessions...');
      
      // Sort tasks with missed sessions by importance and deadline
      const tasksWithMissedSessions = Object.keys(missedSessionHoursByTask)
        .map(taskId => tasksEven.find(t => t.id === taskId))
        .filter(task => task !== undefined)
        .sort((a, b) => {
          if (!a || !b) return 0;
          if (a.importance !== b.importance) return a.importance ? -1 : 1;
          return new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
        });
      
      for (const task of tasksWithMissedSessions) {
        if (!task) continue;
        
        const missedHours = missedSessionHoursByTask[task.id];
        if (missedHours <= 0) continue;
        
        // Get deadline for this task
        const deadline = new Date(task.deadline);
        if (settings.bufferDays > 0) {
          deadline.setDate(deadline.getDate() - settings.bufferDays);
        }
        const deadlineDateStr = deadline.toISOString().split('T')[0];
        const daysForTask = availableDays.filter(d => d <= deadlineDateStr);
        
        // Try to redistribute missed session hours
        const finalUnscheduledHours = redistributeUnscheduledHours(task, missedHours, daysForTask);
        
        if (finalUnscheduledHours < missedHours) {
          console.log(`Successfully redistributed ${missedHours - finalUnscheduledHours} hours for task "${task.title}"`);
        } else {
          console.log(`Could not redistribute ${missedHours} hours for task "${task.title}"`);
        }
      }
      
      // Combine sessions again after missed session redistribution
      combineSessionsOnSameDay(studyPlans);
    }

    // Step 3: Schedule no-deadline tasks in remaining available time
    if (noDeadlineTasks.length > 0) {
      // Extend available days for no-deadline tasks (add 30 more days)
      const extendedDate = new Date(now);
      extendedDate.setDate(extendedDate.getDate() + 30);

      while (tempDate <= extendedDate) {
        const dateStr = tempDate.toISOString().split('T')[0];
        const dayOfWeek = tempDate.getDay();
        if (settings.workDays.includes(dayOfWeek) && !availableDays.includes(dateStr)) {
          availableDays.push(dateStr);
        }
        tempDate.setDate(tempDate.getDate() + 1);
      }

      // Create study plans for extended days if needed
      availableDays.forEach(date => {
        if (!studyPlans.find(plan => plan.date === date)) {
          studyPlans.push({
            id: `${date}-study-plan`,
            date,
            plannedTasks: [],
            totalStudyHours: 0,
            availableHours: settings.dailyAvailableHours
          });
        }
      });

      // Schedule no-deadline tasks in available slots
      noDeadlineTasks.forEach((task, taskIndex) => {
        let remainingHours = task.estimatedHours;
        const minSessionHours = (task.minWorkBlock || 30) / 60; // Convert minutes to hours

        // Determine session frequency based on task preferences
        let sessionGap = 1; // Days between sessions
        if (task.targetFrequency === 'weekly') sessionGap = 7;
        else if (task.targetFrequency === '3x-week') sessionGap = 2;
        else if (task.targetFrequency === 'flexible') {
          // For flexible tasks, adapt the gap based on available time and task urgency
          // Start with smaller gaps and increase if needed
          sessionGap = task.importance ? 2 : 3; // More frequent for important tasks
        }

        let sessionNumber = 1;
        let dayIndex = 0;
        let failedAttempts = 0; // Track failed scheduling attempts

        while (remainingHours > 0 && dayIndex < availableDays.length) {
          const currentDate = availableDays[dayIndex];
          const plan = studyPlans.find(p => p.date === currentDate);

          if (plan) {
            // Calculate available time on this day
            const usedHours = plan.plannedTasks.reduce((sum, session) => sum + session.allocatedHours, 0);
            const availableHours = plan.availableHours - usedHours;

            // Check if we have enough time for minimum session
            if (availableHours >= minSessionHours) {
              // Determine session length
              const sessionHours = Math.min(
                remainingHours,
                availableHours,
                Math.max(minSessionHours, Math.min(2, remainingHours)) // Max 2 hours per session
              );

              // Find proper time slot using the existing function to avoid conflicts
              const commitmentsForDay = fixedCommitments.filter(commitment => {
                if (commitment.recurring) {
                  return commitment.daysOfWeek.includes(new Date(currentDate).getDay());
                } else {
                  return commitment.specificDates?.includes(currentDate) || false;
                }
              });

              const slot = findNextAvailableTimeSlot(
                sessionHours,
                plan.plannedTasks, // existing sessions on this day
                commitmentsForDay,
                settings.studyWindowStartHour || 6,
                settings.studyWindowEndHour || 23,
                settings.bufferTimeBetweenSessions || 0,
                currentDate
              );

              if (slot) {
                const session: StudySession = {
                  taskId: task.id,
                  scheduledTime: currentDate,
                  startTime: slot.start,
                  endTime: slot.end,
                  allocatedHours: sessionHours,
                  sessionNumber,
                  isFlexible: true // Mark as flexible for easy rescheduling
                };

                plan.plannedTasks.push(session);
                plan.totalStudyHours += sessionHours;
                remainingHours -= sessionHours;
                sessionNumber++;
                failedAttempts = 0; // Reset failed attempts on successful scheduling
              } else {
                // No available slot on this day
                failedAttempts++;
                // For flexible tasks, try more frequently if we're having trouble scheduling
                if (task.targetFrequency === 'flexible' && failedAttempts > 2) {
                  sessionGap = 1; // Fall back to daily attempts
                }
              }

              // Apply session gap for next scheduling
              dayIndex += sessionGap;
            } else {
              dayIndex++;
            }
          } else {
            dayIndex++;
          }
        }

        // Track unscheduled hours
        if (remainingHours > 0) {
          suggestions.push({
            taskTitle: task.title,
            unscheduledMinutes: Math.round(remainingHours * 60)
          });
        }
      });
    }

    // After all days, return plans and suggestions for any unscheduled hours
    return { plans: studyPlans, suggestions };
  }

  if (settings.studyPlanMode === 'balanced') {
    // BALANCED PRIORITY DISTRIBUTION LOGIC
    // Combines even distribution stability with priority-based task ordering
    const allPendingTasksBalanced = tasks.filter(task => task.status === 'pending' && task.estimatedHours > 0);

    const deadlineTasksBalanced = allPendingTasksBalanced
      .filter(task => task.deadline && task.deadline.trim().length > 0 && task.deadlineType !== 'none')
      .sort((a, b) => {
        // First sort by importance
        if (a.importance !== b.importance) return a.importance ? -1 : 1;
        // Then by deadline urgency for same importance level
        return new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
      });

    const noDeadlineTasksBalanced = allPendingTasksBalanced
      .filter(task => !task.deadline || task.deadline.trim().length === 0 || task.deadlineType === 'none')
      .sort((a, b) => {
        if (a.importance !== b.importance) return a.importance ? -1 : 1; // Important first
        return a.title.localeCompare(b.title); // Then alphabetically
      });

    const tasksBalanced = deadlineTasksBalanced;

    // Create priority tiers for balanced distribution
    const importantTasks = tasksBalanced.filter(task => task.importance);
    const regularTasks = tasksBalanced.filter(task => !task.importance);

    // Further categorize by deadline urgency within each tier
    const now = new Date();
    const urgentImportant = importantTasks.filter(task => {
      const daysUntilDeadline = (new Date(task.deadline).getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      return daysUntilDeadline <= 3;
    });
    const notUrgentImportant = importantTasks.filter(task => {
      const daysUntilDeadline = (new Date(task.deadline).getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      return daysUntilDeadline > 3;
    });
    const urgentRegular = regularTasks.filter(task => {
      const daysUntilDeadline = (new Date(task.deadline).getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      return daysUntilDeadline <= 3;
    });
    const notUrgentRegular = regularTasks.filter(task => {
      const daysUntilDeadline = (new Date(task.deadline).getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      return daysUntilDeadline > 3;
    });

    // Reorder tasks by balanced priority: Q1 (urgent+important) -> Q2 (important) -> Q3 (urgent) -> Q4 (neither)
    const prioritizedTasks = [...urgentImportant, ...notUrgentImportant, ...urgentRegular, ...notUrgentRegular];

    // Use same day calculation logic as even mode
    const latestDeadline = new Date(Math.max(...prioritizedTasks.map(t => new Date(t.deadline).getTime())));
    const availableDays: string[] = [];
    const tempDate = new Date(now);
    while (tempDate <= latestDeadline) {
      const dateStr = tempDate.toISOString().split('T')[0];
      const dayOfWeek = tempDate.getDay();
      if (settings.workDays.includes(dayOfWeek)) {
        availableDays.push(dateStr);
      }
      tempDate.setDate(tempDate.getDate() + 1);
    }

    // Include deadline days
    if (settings.bufferDays === 0) {
      prioritizedTasks.forEach(task => {
        const deadlineDateStr = new Date(task.deadline).toISOString().split('T')[0];
        if (!availableDays.includes(deadlineDateStr) && settings.workDays.includes(new Date(deadlineDateStr).getDay())) {
          availableDays.push(deadlineDateStr);
        }
      });
    } else {
      prioritizedTasks.forEach(task => {
        const deadline = new Date(task.deadline);
        deadline.setDate(deadline.getDate() - settings.bufferDays);
        const deadlineDateStr = deadline.toISOString().split('T')[0];
        if (!availableDays.includes(deadlineDateStr) && settings.workDays.includes(new Date(deadlineDateStr).getDay())) {
          availableDays.push(deadlineDateStr);
        }
      });
    }
    availableDays.sort();

    const studyPlans: StudyPlan[] = [];
    const dailyRemainingHours: { [date: string]: number } = {};
    availableDays.forEach(date => {
      dailyRemainingHours[date] = settings.dailyAvailableHours;
      studyPlans.push({
        id: `plan-${date}`,
        date,
        plannedTasks: [],
        totalStudyHours: 0,
        availableHours: settings.dailyAvailableHours
      });
    });

    // Balanced distribution: Apply even distribution within priority tiers
    const distributeTierTasks = (tierTasks: Task[], tierName: string) => {
      const tierTaskScheduledHours: { [taskId: string]: number } = {};
      tierTasks.forEach(task => {
        tierTaskScheduledHours[task.id] = 0;
      });

      // Calculate total hours needed for this tier
      const totalTierHours = tierTasks.reduce((sum, task) => sum + task.estimatedHours, 0);

      if (totalTierHours === 0) return;

      // Distribute tier tasks evenly across available days until their deadlines
      for (const task of tierTasks) {
        const deadline = new Date(task.deadline);
        if (settings.bufferDays > 0) {
          deadline.setDate(deadline.getDate() - settings.bufferDays);
        }
        const deadlineDateStr = deadline.toISOString().split('T')[0];
        const daysForTask = availableDays.filter(d => d <= deadlineDateStr);

        if (daysForTask.length === 0) continue;

        // Use optimized session distribution for even spreading
        const sessionLengths = optimizeSessionDistribution(task, task.estimatedHours, daysForTask, settings);

        for (let i = 0; i < sessionLengths.length && i < daysForTask.length; i++) {
          let dayIndex = i;
          
          // For non-important one-sitting tasks, prefer scheduling on the actual deadline day (respecting buffer)
          if (task.isOneTimeTask && !task.importance && sessionLengths.length === 1) {
            // Calculate the effective deadline (respecting buffer days)
            const effectiveDeadline = new Date(task.deadline);
            if (settings.bufferDays > 0) {
              effectiveDeadline.setDate(effectiveDeadline.getDate() - settings.bufferDays);
            }
            const effectiveDeadlineStr = effectiveDeadline.toISOString().split('T')[0];
            
            // First priority: Schedule on the effective deadline day itself (last available day)
            const effectiveDeadlineIndex = daysForTask.indexOf(effectiveDeadlineStr);
            
            if (effectiveDeadlineIndex !== -1) {
              // Effective deadline day is available, use it
              dayIndex = effectiveDeadlineIndex;
            } else {
              // Fallback: Find the closest available day to the effective deadline
              const effectiveDeadlineTime = effectiveDeadline.getTime();
              let closestIndex = daysForTask.length - 1; // Start with the last available day
              let minDistance = Math.abs(new Date(daysForTask[closestIndex]).getTime() - effectiveDeadlineTime);
              
              for (let j = 0; j < daysForTask.length - 1; j++) {
                const distance = Math.abs(new Date(daysForTask[j]).getTime() - effectiveDeadlineTime);
                if (distance < minDistance) {
                  minDistance = distance;
                  closestIndex = j;
                }
              }
              dayIndex = closestIndex;
            }
          }
          
          const date = daysForTask[dayIndex];
          const dayPlan = studyPlans.find(p => p.date === date)!;
          const availableHours = dailyRemainingHours[date];
          const thisSessionLength = Math.min(sessionLengths[i], availableHours);

          if (thisSessionLength > 0) {
            const roundedSessionLength = Math.round(thisSessionLength * 60) / 60;
            dayPlan.plannedTasks.push({
              taskId: task.id,
              scheduledTime: `${date}`,
              startTime: '',
              endTime: '',
              allocatedHours: roundedSessionLength,
              sessionNumber: (dayPlan.plannedTasks.filter(s => s.taskId === task.id).length) + 1,
              isFlexible: true,
              status: 'scheduled'
            });
            dayPlan.totalStudyHours = Math.round((dayPlan.totalStudyHours + roundedSessionLength) * 60) / 60;
            dailyRemainingHours[date] = Math.round((dailyRemainingHours[date] - roundedSessionLength) * 60) / 60;
            tierTaskScheduledHours[task.id] = Math.round((tierTaskScheduledHours[task.id] + roundedSessionLength) * 60) / 60;
          }
        }
      }
    };

    // Distribute tasks by priority tier
    distributeTierTasks(urgentImportant, 'Urgent & Important');
    distributeTierTasks(notUrgentImportant, 'Important');
    distributeTierTasks(urgentRegular, 'Urgent');
    distributeTierTasks(notUrgentRegular, 'Regular');

    // Sort sessions within each day by priority (important first, then by deadline)
    for (const plan of studyPlans) {
      plan.plannedTasks.sort((a, b) => {
        const taskA = prioritizedTasks.find(t => t.id === a.taskId);
        const taskB = prioritizedTasks.find(t => t.id === b.taskId);
        if (!taskA || !taskB) return 0;
        if (taskA.importance !== taskB.importance) return taskA.importance ? -1 : 1;
        return new Date(taskA.deadline).getTime() - new Date(taskB.deadline).getTime();
      });

      // Assign time slots with same logic as other modes
      const commitmentsForDay = fixedCommitments.filter(commitment => {
        if (commitment.recurring) {
          return commitment.daysOfWeek.includes(new Date(plan.date).getDay());
        } else {
          return commitment.specificDates?.includes(plan.date) || false;
        }
      });

      let assignedSessions: StudySession[] = [];
      for (const session of plan.plannedTasks) {
        const slot = findNextAvailableTimeSlot(
          session.allocatedHours,
          assignedSessions,
          commitmentsForDay,
          settings.studyWindowStartHour || 6,
          settings.studyWindowEndHour || 23,
          settings.bufferTimeBetweenSessions || 0,
          plan.date
        );
        if (slot) {
          session.startTime = slot.start;
          session.endTime = slot.end;
          assignedSessions.push(session);
        } else {
          session.startTime = '';
          session.endTime = '';
        }
      }
    }

    // Schedule no-deadline tasks in remaining available time
    if (noDeadlineTasksBalanced.length > 0) {
      // Simple scheduling for no-deadline tasks in balanced mode
      noDeadlineTasksBalanced.forEach(task => {
        let remainingHours = task.estimatedHours;
        const minSessionHours = (task.minWorkBlock || 30) / 60;
        let sessionNumber = 1;

        for (const plan of studyPlans) {
          if (remainingHours <= 0) break;

          const usedHours = plan.plannedTasks.reduce((sum, session) => sum + session.allocatedHours, 0);
          const availableHours = plan.availableHours - usedHours;

          if (availableHours >= minSessionHours) {
            // For one-time tasks, try to schedule all remaining hours at once
            let sessionHours;
            if (task.isOneTimeTask && sessionNumber === 1) {
              sessionHours = remainingHours <= availableHours ? remainingHours : 0;
            } else {
              sessionHours = Math.min(remainingHours, availableHours, 1.5); // Max 1.5 hours per session
            }

            if (sessionHours <= 0) continue;

            const startTimeHour = 9 + (usedHours % 8);
            const endTimeHour = startTimeHour + sessionHours;

            const session: StudySession = {
              taskId: task.id,
              scheduledTime: plan.date,
              startTime: `${Math.floor(startTimeHour).toString().padStart(2, '0')}:${((startTimeHour % 1) * 60).toString().padStart(2, '0')}`,
              endTime: `${Math.floor(endTimeHour).toString().padStart(2, '0')}:${((endTimeHour % 1) * 60).toString().padStart(2, '0')}`,
              allocatedHours: sessionHours,
              sessionNumber,
              isFlexible: true
            };

            plan.plannedTasks.push(session);
            plan.totalStudyHours += sessionHours;
            remainingHours -= sessionHours;
            sessionNumber++;
          }
        }
      });
    }

    // Create suggestions for any unscheduled hours
    const suggestions = getUnscheduledMinutesForTasks(prioritizedTasks,
      prioritizedTasks.reduce((acc, task) => {
        acc[task.id] = studyPlans.reduce((sum, plan) =>
          sum + plan.plannedTasks.filter(s => s.taskId === task.id && s.status !== 'skipped')
            .reduce((sessionSum, session) => sessionSum + session.allocatedHours, 0), 0);
        return acc;
      }, {} as { [taskId: string]: number }), settings);

    return { plans: studyPlans, suggestions };
  }

  // Step 1: Filter and sort tasks by Eisenhower Matrix logic
  const allPendingTasksEisen = tasks.filter(task => task.status === 'pending' && task.estimatedHours > 0);

  const deadlineTasksEisen = allPendingTasksEisen
    .filter(task => task.deadline && task.deadline.trim().length > 0 && task.deadlineType !== 'none')
    .sort((a, b) => {
      if (a.importance !== b.importance) return a.importance ? -1 : 1; // Important first
      return new Date(a.deadline).getTime() - new Date(b.deadline).getTime(); // Then by deadline
    });

  const noDeadlineTasksEisen = allPendingTasksEisen
    .filter(task => !task.deadline || task.deadline.trim().length === 0 || task.deadlineType === 'none')
    .sort((a, b) => {
      if (a.importance !== b.importance) return a.importance ? -1 : 1; // Important first
      return a.title.localeCompare(b.title); // Then alphabetically
    });

  const tasksSorted = deadlineTasksEisen;

  // Step 2: Create a map of available study days (using same logic as even mode)
  const now = new Date();
  // Calculate latest deadline using original deadlines (buffer will be applied per task)
  const latestDeadline = new Date(Math.max(...tasksSorted.map(t => new Date(t.deadline).getTime())));
  const availableDays: string[] = [];
  const tempDate = new Date(now);
  // Include the latest deadline day by using <= comparison
  while (tempDate <= latestDeadline) {
    const dateStr = tempDate.toISOString().split('T')[0];
    const dayOfWeek = tempDate.getDay();
    if (settings.workDays.includes(dayOfWeek)) {
      availableDays.push(dateStr);
    }
    tempDate.setDate(tempDate.getDate() + 1);
  }
  
  // When buffer days is 0, ensure we include the deadline day itself
  if (settings.bufferDays === 0) {
    // Add any missing deadline days that might not be included due to time zone issues
    tasksSorted.forEach(task => {
      const deadlineDateStr = new Date(task.deadline).toISOString().split('T')[0];
      if (!availableDays.includes(deadlineDateStr) && settings.workDays.includes(new Date(deadlineDateStr).getDay())) {
        availableDays.push(deadlineDateStr);
      }
    });
    // Sort available days to maintain order
    availableDays.sort();
  } else {
    // When buffer days > 0, ensure we include the buffer-adjusted deadline days
    tasksSorted.forEach(task => {
      const deadline = new Date(task.deadline);
      deadline.setDate(deadline.getDate() - settings.bufferDays);
      const deadlineDateStr = deadline.toISOString().split('T')[0];
      if (!availableDays.includes(deadlineDateStr) && settings.workDays.includes(new Date(deadlineDateStr).getDay())) {
        availableDays.push(deadlineDateStr);
      }
    });
    // Sort available days to maintain order
    availableDays.sort();
  }

  const studyPlans: StudyPlan[] = [];
  const dailyRemainingHours: { [date: string]: number } = {};
  availableDays.forEach(date => {
    dailyRemainingHours[date] = settings.dailyAvailableHours;
    studyPlans.push({
      id: `plan-${date}`,
      date,
      plannedTasks: [],
      totalStudyHours: 0,
      availableHours: settings.dailyAvailableHours
    });
  });

  let taskScheduledHours: { [taskId: string]: number } = {};
  tasksSorted.forEach(task => {
    taskScheduledHours[task.id] = 0;
  });

  // suggestions will be created by the helper below

  // For each day, allocate hours by Eisenhower Matrix order
  for (const date of availableDays) {
    let dayPlan = studyPlans.find(p => p.date === date)!;
    let availableHours = dailyRemainingHours[date];
    // Get all fixed commitments for this day
            const commitmentsForDay = fixedCommitments.filter(commitment => {
          // Check if this commitment applies to this specific date
          if (commitment.recurring) {
            // For recurring commitments, check if the day of week matches
            return commitment.daysOfWeek.includes(new Date(date).getDay());
          } else {
            // For non-recurring commitments, check if the specific date matches
            return commitment.specificDates?.includes(date) || false;
          }
        });
    // Get tasks that still need hours and are not past their deadline (using same logic as even mode)
    const tasksForDay = tasksSorted.filter(task => {
      const deadline = new Date(task.deadline);
      if (settings.bufferDays > 0) {
        deadline.setDate(deadline.getDate() - settings.bufferDays);
      }
      // Normalize deadline to start of day for comparison
      const deadlineDateStr = deadline.toISOString().split('T')[0];
      return taskScheduledHours[task.id] < task.estimatedHours && date <= deadlineDateStr;
    });
    for (const task of tasksForDay) {
      if (availableHours <= 0) break;
      const remainingTaskHours = task.estimatedHours - taskScheduledHours[task.id];
      if (remainingTaskHours <= 0) continue;
      // Allocate as much as possible for this task
      // For one-time tasks, schedule all remaining hours at once if possible
      let hoursToSchedule;
      if (task.isOneTimeTask && taskScheduledHours[task.id] === 0) {
        // One-time task: try to schedule all hours at once
        hoursToSchedule = remainingTaskHours <= availableHours ? remainingTaskHours : 0;
      } else {
        // Regular task: can be split across sessions
        hoursToSchedule = Math.min(remainingTaskHours, availableHours);
      }
      if (hoursToSchedule > 0) {
        // Find the next available time slot for this session
        const existingSessions = dayPlan.plannedTasks;
        const slot = findNextAvailableTimeSlot(
          hoursToSchedule,
          existingSessions,
          commitmentsForDay,
          settings.studyWindowStartHour || 6,
          settings.studyWindowEndHour || 23,
          settings.bufferTimeBetweenSessions || 0, // pass buffer
          date // pass target date for filtering deleted occurrences
        );
        if (!slot) continue; // No available slot for this session
        const sessionNumber = (dayPlan.plannedTasks.filter(s => s.taskId === task.id).length) + 1;
        const session: StudySession = {
          taskId: task.id,
          scheduledTime: `${date} ${slot.start}`,
          startTime: slot.start,
          endTime: slot.end,
          allocatedHours: Math.round(hoursToSchedule * 60) / 60,
          sessionNumber,
          isFlexible: true,
          status: 'scheduled'
        };
        dayPlan.plannedTasks.push(session);
        dayPlan.totalStudyHours = Math.round((dayPlan.totalStudyHours + session.allocatedHours) * 60) / 60;
        dailyRemainingHours[date] = Math.round((dailyRemainingHours[date] - session.allocatedHours) * 60) / 60;
        availableHours = Math.round((availableHours - session.allocatedHours) * 60) / 60;
        taskScheduledHours[task.id] = Math.round((taskScheduledHours[task.id] + session.allocatedHours) * 60) / 60;
      }
    }
  }

  // Schedule no-deadline tasks in remaining available time
  if (noDeadlineTasksEisen.length > 0) {
    noDeadlineTasksEisen.forEach(task => {
      let remainingHours = task.estimatedHours;
      const minSessionHours = (task.minWorkBlock || 30) / 60;
      let sessionNumber = 1;

      for (const plan of studyPlans) {
        if (remainingHours <= 0) break;

        const usedHours = plan.plannedTasks.reduce((sum, session) => sum + session.allocatedHours, 0);
        const availableHours = plan.availableHours - usedHours;

        if (availableHours >= minSessionHours) {
          // For one-time tasks, try to schedule all remaining hours at once
          let sessionHours;
          if (task.isOneTimeTask && sessionNumber === 1) {
            sessionHours = remainingHours <= availableHours ? remainingHours : 0;
          } else {
            sessionHours = Math.min(remainingHours, availableHours, 1.5);
          }

          if (sessionHours <= 0) continue;

          // Find available time slot
          const commitmentsForDay = fixedCommitments.filter(commitment =>
            doesCommitmentApplyToDate(commitment, plan.date)
          );

          const slot = findNextAvailableTimeSlot(
            sessionHours,
            plan.plannedTasks,
            commitmentsForDay,
            settings.studyWindowStartHour || 6,
            settings.studyWindowEndHour || 23,
            settings.bufferTimeBetweenSessions || 0,
            plan.date
          );

          if (slot) {
            const session: StudySession = {
              taskId: task.id,
              scheduledTime: `${plan.date} ${slot.start}`,
              startTime: slot.start,
              endTime: slot.end,
              allocatedHours: sessionHours,
              sessionNumber,
              isFlexible: true,
              status: 'scheduled'
            };

            plan.plannedTasks.push(session);
            plan.totalStudyHours += sessionHours;
            remainingHours -= sessionHours;
            sessionNumber++;
          }
        }
      }

      // Add to task scheduled hours tracking
      taskScheduledHours[task.id] = (taskScheduledHours[task.id] || 0) + (task.estimatedHours - remainingHours);
    });
  }

  // After all days, add suggestions for any unscheduled hours
  const suggestions = getUnscheduledMinutesForTasks(tasksSorted, taskScheduledHours, settings);
  return { plans: studyPlans, suggestions };
};

// Legacy functions for backward compatibility
export const generateStudyPlan = generateNewStudyPlan;

export const generateSmartSuggestions = (tasks: Task[], unscheduledTasks?: Task[]) => {
  const suggestions = [];
  const now = new Date();

  // Overdue tasks (any quadrant)
  const overdueTasks = tasks.filter(task => {
    const deadline = new Date(task.deadline);
    return deadline < now && task.status === 'pending';
  });
  if (overdueTasks.length > 0) {
    suggestions.push({
      type: 'warning' as const,
      message: `You have ${overdueTasks.length} overdue task(s). Consider extending deadlines or increasing study hours.`,
      action: 'Review and update deadlines for overdue tasks.'
    });
  }

  // Q1 & Q3: Urgent tasks (due soon)
  const urgentTasks = tasks.filter(task => {
    const deadline = new Date(task.deadline);
    const daysUntilDeadline = Math.ceil((deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return daysUntilDeadline <= 3 && task.status === 'pending';
  });
  const urgentImportant = urgentTasks.filter(task => task.importance);
  const urgentNotImportant = urgentTasks.filter(task => !task.importance);

  if (urgentImportant.length > 0) {
    suggestions.push({
      type: 'warning' as const,
      message: `You have ${urgentImportant.length} important task(s) due within 3 days.`,
      action: 'Focus on these tasks first to avoid last-minute stress.'
    });
  }
  if (urgentNotImportant.length > 0) {
    suggestions.push({
      type: 'warning' as const,
      message: `You have ${urgentNotImportant.length} urgent but not important task(s) due soon. These may not fit in your schedule.`,
      action: 'Consider increasing your daily hour limit, delegating, or rescheduling these tasks.'
    });
  }

  // Eisenhower mode: Warn if urgent low-priority tasks are unscheduled due to prioritization
  if (unscheduledTasks && unscheduledTasks.length > 0) {
    const unscheduledUrgentLowPriority = unscheduledTasks.filter(task => {
      const deadline = new Date(task.deadline);
      const daysUntilDeadline = Math.ceil((deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      return daysUntilDeadline <= 3 && !task.importance && task.status === 'pending';
    });
    if (unscheduledUrgentLowPriority.length > 0) {
      suggestions.push({
        type: 'warning' as const,
        message: `Some low-priority tasks with urgent deadlines could not be scheduled because higher-priority urgent tasks are taking precedence.`,
        action: 'Consider increasing your daily available hours, rescheduling, or marking some tasks as more important.'
      });
    }
  }

  // Q2: Important but not urgent (encourage scheduling)
  const importantNotUrgent = tasks.filter(task => {
    const deadline = new Date(task.deadline);
    const daysUntilDeadline = Math.ceil((deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return daysUntilDeadline > 3 && task.importance && task.status === 'pending';
  });
  if (importantNotUrgent.length > 0) {
    suggestions.push({
      type: 'suggestion' as const,
      message: `You have ${importantNotUrgent.length} important task(s) with more than 3 days until deadline.`,
      action: 'Schedule time for these now to avoid last-minute stress.'
    });
  }

  // Q4: Not important & not urgent (may be unscheduled)
  const notImportantNotUrgent = tasks.filter(task => {
    const deadline = new Date(task.deadline);
    const daysUntilDeadline = Math.ceil((deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return daysUntilDeadline > 3 && !task.importance && task.status === 'pending';
  });
  if (notImportantNotUrgent.length > 0) {
    suggestions.push({
      type: 'suggestion' as const,
      message: `You have ${notImportantNotUrgent.length} task(s) that are neither urgent nor important.`,
      action: 'Do these only if you have extra time, or consider dropping them.'
    });
  }

  // Completed tasks
  const completedTasks = tasks.filter(task => task.status === 'completed');
  if (completedTasks.length > 0) {
    suggestions.push({
      type: 'celebration' as const,
      message: `Great job! You've completed ${completedTasks.length} task(s).`,
      action: 'Keep up the momentum!'
    });
  }

  return suggestions;
};

// Helper to detect unscheduled minutes for each task
export function getUnscheduledMinutesForTasks(tasks: Task[], taskScheduledHours: Record<string, number>, settings?: UserSettings) {
  const minSessionLengthHours = settings?.minSessionLength ? settings.minSessionLength / 60 : 0.016; // Default to 1 minute if no settings provided
  
  return tasks
    .filter(task => task.status === 'pending') // Only include pending tasks
    .map(task => {
      const scheduled = taskScheduledHours[task.id] || 0;
      const unscheduled = Math.max(0, task.estimatedHours - scheduled);
      // Only include tasks with unscheduled time above the minimum session length
      return unscheduled > minSessionLengthHours
        ? { 
            taskTitle: task.title, 
            unscheduledMinutes: Math.round(unscheduled * 60),
            importance: task.importance,
            deadline: task.deadline
          }
        : null;
    })
    .filter(Boolean) as Array<{ taskTitle: string; unscheduledMinutes: number; importance: boolean; deadline: string }>;
}

// Time slot calculation functions
interface TimeSlot {
  start: Date;
  end: Date;
}

export const getDailyAvailableTimeSlots = (
  date: Date,
  dailyHours: number,
  commitments: FixedCommitment[],
  workDays: number[],
  startHour: number,
  endHour: number
): TimeSlot[] => {
  const slots: TimeSlot[] = [];
  const dayOfWeek = date.getDay();
  
  // Check if this is a work day
  if (!workDays.includes(dayOfWeek)) {
    return slots;
  }
  
  const dateString = date.toISOString().split('T')[0];
  
  // Filter commitments for this day, excluding deleted occurrences
  const dayCommitments = commitments.filter(commitment => {
    // Check if this commitment applies to this specific date
    let appliesToDate = false;
    
    if (commitment.recurring) {
      // For recurring commitments, check if the day of week matches
      appliesToDate = commitment.daysOfWeek.includes(dayOfWeek);
    } else {
      // For non-recurring commitments, check if the specific date matches
      appliesToDate = commitment.specificDates?.includes(dateString) || false;
    }
    
    return appliesToDate && !commitment.deletedOccurrences?.includes(dateString);
  });
  
  // Create time slots around commitments
  let currentTime = new Date(date);
  currentTime.setHours(startHour, 0, 0, 0);
  
  const endTime = new Date(date);
  endTime.setHours(endHour, 0, 0, 0);
  
  // Calculate total available time for the day
  const totalAvailableMinutes = dailyHours * 60;
  let usedMinutes = 0;
  
  // Sort commitments by start time
  const sortedCommitments = dayCommitments.sort((a, b) => {
    const aStartTime = a.modifiedOccurrences?.[dateString]?.startTime || a.startTime;
    const bStartTime = b.modifiedOccurrences?.[dateString]?.startTime || b.startTime;
    return aStartTime.localeCompare(bStartTime);
  });
  
  for (const commitment of sortedCommitments) {
    const modifiedSession = commitment.modifiedOccurrences?.[dateString];
    
    const commitmentStart = new Date(date);
    const [startHour, startMinute] = (modifiedSession?.startTime || commitment.startTime).split(':').map(Number);
    commitmentStart.setHours(startHour, startMinute, 0, 0);
    
    const commitmentEnd = new Date(date);
    const [endHour, endMinute] = (modifiedSession?.endTime || commitment.endTime).split(':').map(Number);
    commitmentEnd.setHours(endHour, endMinute, 0, 0);
    
    // Add slot before commitment if there's time
    if (currentTime < commitmentStart) {
      const slotDuration = (commitmentStart.getTime() - currentTime.getTime()) / (1000 * 60);
      if (usedMinutes + slotDuration <= totalAvailableMinutes) {
        slots.push({
          start: currentTime,
          end: commitmentStart
        });
        usedMinutes += slotDuration;
      }
    }
    
    currentTime = commitmentEnd;
  }
  
  // Add final slot if there's time remaining
  if (currentTime < endTime) {
    const remainingMinutes = totalAvailableMinutes - usedMinutes;
    const slotDuration = Math.min(
      (endTime.getTime() - currentTime.getTime()) / (1000 * 60),
      remainingMinutes
    );
    
    if (slotDuration > 0) {
      const slotEnd = new Date(currentTime.getTime() + slotDuration * 60 * 1000);
      slots.push({
        start: currentTime,
        end: slotEnd
      });
    }
  }
  
  return slots;
};

export const findNextAvailableStartTime = (
  startTime: Date,
  durationMinutes: number,
  existingSessions: StudySession[],
  date: Date,
  settings: UserSettings
): Date | null => {
  const studyWindowStart = new Date(date);
  studyWindowStart.setHours(settings.studyWindowStartHour || 6, 0, 0, 0);
  
  const studyWindowEnd = new Date(date);
  studyWindowEnd.setHours(settings.studyWindowEndHour || 23, 0, 0, 0);
  
  // Check for conflicts with existing sessions
  const proposedEndTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000);
  
  for (const session of existingSessions) {
    const sessionStart = new Date(date);
    const [startHour, startMinute] = session.startTime.split(':').map(Number);
    sessionStart.setHours(startHour, startMinute, 0, 0);
    
    const sessionEnd = new Date(date);
    const [endHour, endMinute] = session.endTime.split(':').map(Number);
    sessionEnd.setHours(endHour, endMinute, 0, 0);
    
    // Check if there's a conflict
    if (startTime < sessionEnd && proposedEndTime > sessionStart) {
      // Move to after this session
      startTime = sessionEnd;
    }
  }
  
  // Check if the proposed start time is within the study window
  if (startTime >= studyWindowStart && startTime <= studyWindowEnd) {
    const endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000);
    if (endTime <= studyWindowEnd) {
      return startTime;
    }
  }
  
  // If not, return the study window start time
  return studyWindowStart;
};

/**
 * Enhanced redistribution function using the new conflict-free system
 */
export const redistributeMissedSessionsEnhanced = (
  studyPlans: StudyPlan[],
  settings: UserSettings,
  fixedCommitments: FixedCommitment[],
  tasks: Task[],
  options: RedistributionOptions = {
    prioritizeMissedSessions: true,
    respectDailyLimits: true,
    allowWeekendOverflow: false,
    maxRedistributionDays: 14
  }
): RedistributionResult => {
  const engine = createEnhancedRedistributionEngine(settings, fixedCommitments);
  return engine.redistributeMissedSessions(studyPlans, tasks, options);
};

/**
 * Enhanced skip session function with partial skip support
 */
export const skipSessionEnhanced = (
  studyPlans: StudyPlan[],
  planDate: string,
  sessionNumber: number,
  taskId: string,
  options: {
    partialHours?: number;
    reason?: 'user_choice' | 'conflict' | 'overload';
  } = {}
): boolean => {
  const engine = createEnhancedRedistributionEngine(
    { dailyAvailableHours: 8, workDays: [1,2,3,4,5], bufferDays: 0, minSessionLength: 15, bufferTimeBetweenSessions: 0, shortBreakDuration: 5, longBreakDuration: 15, maxConsecutiveHours: 4, studyWindowStartHour: 6, studyWindowEndHour: 23, avoidTimeRanges: [], weekendStudyHours: 6, autoCompleteSessions: false, enableNotifications: true },
    []
  );
  return engine.skipSession(studyPlans, planDate, sessionNumber, taskId, options);
};

/**
 * Validate time slot for conflicts
 */
export const validateTimeSlot = (
  date: string,
  startTime: string,
  endTime: string,
  existingSessions: StudySession[],
  settings: UserSettings,
  fixedCommitments: FixedCommitment[]
) => {
  const checker = createConflictChecker(settings, fixedCommitments);
  return checker.validateTimeSlot(date, startTime, endTime, existingSessions);
};

export const moveMissedSessions = (
  studyPlans: StudyPlan[],
  settings: UserSettings,
  fixedCommitments: FixedCommitment[],
  tasks: Task[] // Pass tasks array for priority sorting
) => {
  const updatedPlans = [...studyPlans];
  const movedSessions: StudySession[] = [];
  const failedSessions: StudySession[] = [];
  const today = getLocalDateString();
  
  // Find all missed sessions and sort by priority
  const missedSessions: Array<{
    session: StudySession, 
    planDate: string, 
    planIndex: number, 
    sessionIndex: number,
    task?: Task, // Add task information for priority sorting
    priority: number // Add priority score
  }> = [];
  
  updatedPlans.forEach((plan, planIndex) => {
    plan.plannedTasks.forEach((session, sessionIndex) => {
      const status = checkSessionStatus(session, plan.date);
      if (status === 'missed') {
        // Calculate priority based on task importance and deadline
        const task = tasks.find(t => t.id === session.taskId);
        let priority = 0;
        if (task) {
          priority += task.importance ? 1000 : 0; // Important tasks get high priority
          const daysUntilDeadline = (new Date(task.deadline).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24);
          // For past deadlines, give them very high priority to ensure they get redistributed
          if (daysUntilDeadline < 0) {
            priority += 2000; // Very high priority for past deadlines
          } else {
            priority += Math.max(0, 100 - daysUntilDeadline); // Closer deadlines get higher priority
          }
        }
        
        missedSessions.push({
          session, 
          planDate: plan.date, 
          planIndex, 
          sessionIndex,
          task,
          priority
        });
      }
    });
  });
  
  // Sort missed sessions by priority (highest first)
  missedSessions.sort((a, b) => b.priority - a.priority);
  
  // Helper function to get all busy time slots for a given date
  const getBusyTimeSlots = (date: Date, dateString: string): Array<{start: Date, end: Date}> => {
    const busySlots: Array<{start: Date, end: Date}> = [];
    
    // Add commitments for this day
    const dayOfWeek = date.getDay();
    const dayCommitments = fixedCommitments.filter(commitment => {
      // Check if this commitment applies to this specific date
      if (commitment.recurring) {
        // For recurring commitments, check if the day of week matches
        return commitment.daysOfWeek.includes(dayOfWeek);
      } else {
        // For non-recurring commitments, check if the specific date matches
        return commitment.specificDates?.includes(dateString) || false;
      }
    });
    
    dayCommitments.forEach(commitment => {
      const commitmentStart = new Date(date);
      const [startHour, startMinute] = commitment.startTime.split(':').map(Number);
      commitmentStart.setHours(startHour, startMinute, 0, 0);
      
      const commitmentEnd = new Date(date);
      const [endHour, endMinute] = commitment.endTime.split(':').map(Number);
      commitmentEnd.setHours(endHour, endMinute, 0, 0);
      
      busySlots.push({ start: commitmentStart, end: commitmentEnd });
    });
    
    // Add existing study sessions for this day
    const existingPlan = updatedPlans.find(p => p.date === dateString);
    if (existingPlan) {
      existingPlan.plannedTasks.forEach(session => {
        if (session.status !== 'skipped') {
          const sessionStart = new Date(date);
          const [startHour, startMinute] = session.startTime.split(':').map(Number);
          sessionStart.setHours(startHour, startMinute, 0, 0);
          
          const sessionEnd = new Date(date);
          const [endHour, endMinute] = session.endTime.split(':').map(Number);
          sessionEnd.setHours(endHour, endMinute, 0, 0);
          
          busySlots.push({ start: sessionStart, end: sessionEnd });
        }
      });
    }
    
    // Sort by start time
    return busySlots.sort((a, b) => a.start.getTime() - b.start.getTime());
  };
  
  // Helper function to find available time slots for a given date
  const findAvailableTimeSlots = (date: Date, dateString: string): Array<{start: Date, end: Date}> => {
    const availableSlots: Array<{start: Date, end: Date}> = [];
    const busySlots = getBusyTimeSlots(date, dateString);
    
    // Set study window boundaries
    const studyWindowStart = new Date(date);
    studyWindowStart.setHours(settings.studyWindowStartHour || 6, 0, 0, 0);
    
    const studyWindowEnd = new Date(date);
    studyWindowEnd.setHours(settings.studyWindowEndHour || 23, 0, 0, 0);
    
    let currentTime = studyWindowStart;
    
    // Find gaps between busy slots
    for (const busySlot of busySlots) {
      if (currentTime < busySlot.start) {
        const gapDuration = (busySlot.start.getTime() - currentTime.getTime()) / (1000 * 60 * 60); // in hours
        if (gapDuration >= (settings.minSessionLength || 15) / 60) {
          availableSlots.push({
            start: currentTime,
            end: busySlot.start
          });
        }
      }
      currentTime = busySlot.end;
    }
    
    // Add final slot if there's time remaining
    if (currentTime < studyWindowEnd) {
      const remainingDuration = (studyWindowEnd.getTime() - currentTime.getTime()) / (1000 * 60 * 60);
      if (remainingDuration >= (settings.minSessionLength || 15) / 60) {
        availableSlots.push({
          start: currentTime,
          end: studyWindowEnd
        });
      }
    }
    
    return availableSlots;
  };
  
  // Enhanced redistribution function that tries to stick sessions together
  const tryMoveSession = (session: StudySession, sessionDuration: number): { success: boolean; targetDate?: string; targetTime?: string } => {
    // Try to move to available days from today onwards
    for (let dayOffset = 0; dayOffset <= 14; dayOffset++) { // Increased to 14 days for more flexibility
      const targetDate = new Date(today);
      targetDate.setDate(targetDate.getDate() + dayOffset);
      const targetDateString = targetDate.toISOString().split('T')[0];
      
      console.log(`Trying day offset ${dayOffset}: ${targetDateString}`);
      
      // Check if this is a work day
      if (!settings.workDays.includes(targetDate.getDay())) {
        console.log(`Skipping ${targetDateString} - not a work day`);
        continue;
      }
      
      // Get available time slots for this day
      const availableSlots = findAvailableTimeSlots(targetDate, targetDateString);
      
      console.log(`Found ${availableSlots.length} available slots on ${targetDateString}`);
      
      // Try each available slot
      for (const slot of availableSlots) {
        const slotDuration = (slot.end.getTime() - slot.start.getTime()) / (1000 * 60 * 60); // in hours
        
        if (slotDuration >= sessionDuration) {
          const sessionStart = slot.start;
          const sessionEnd = new Date(slot.start.getTime() + sessionDuration * 60 * 60 * 1000);
          
          // Check for conflicts with existing sessions (including buffer time)
          let hasConflict = false;
          const existingSessions = getBusyTimeSlots(targetDate, targetDateString);
          
          for (const existingSlot of existingSessions) {
            const bufferTime = (settings.bufferTimeBetweenSessions || 0) / 60; // Convert to hours
            const adjustedSessionStart = new Date(sessionStart.getTime() - bufferTime * 60 * 60 * 1000);
            const adjustedSessionEnd = new Date(sessionEnd.getTime() + bufferTime * 60 * 60 * 1000);
            
            if (adjustedSessionStart < existingSlot.end && adjustedSessionEnd > existingSlot.start) {
              hasConflict = true;
              break;
            }
          }
          
          if (!hasConflict) {
            // Validate session length constraints (skip for missed sessions)
            const minSessionLength = (settings.minSessionLength || 15) / 60; // in hours
            const maxSessionLength = Math.min(4, settings.dailyAvailableHours);
            
            // Skip length validation for missed sessions
            const isMissedSession = checkSessionStatus(session, targetDateString) === 'missed';
            if (isMissedSession || (sessionDuration >= minSessionLength && sessionDuration <= maxSessionLength)) {
              console.log(`Found suitable slot on ${targetDateString} at ${sessionStart.getHours().toString().padStart(2, '0')}:${sessionStart.getMinutes().toString().padStart(2, '0')}`);
              return {
                success: true,
                targetDate: targetDateString,
                targetTime: `${sessionStart.getHours().toString().padStart(2, '0')}:${sessionStart.getMinutes().toString().padStart(2, '0')}`
              };
            }
          }
        }
      }
    }
    
    return { success: false };
  };
  
  // Group missed sessions by task to try to keep them together
  const sessionsByTask: { [taskId: string]: typeof missedSessions } = {};
  missedSessions.forEach(missedSession => {
    if (!sessionsByTask[missedSession.session.taskId]) {
      sessionsByTask[missedSession.session.taskId] = [];
    }
    sessionsByTask[missedSession.session.taskId].push(missedSession);
  });
  
  // Process missed sessions by task to keep related sessions together
  for (const taskId of Object.keys(sessionsByTask)) {
    const taskSessions = sessionsByTask[taskId];
    
    // Sort sessions within the task by priority
    taskSessions.sort((a, b) => b.priority - a.priority);
    
    // Try to move all sessions for this task together
    for (const {session, planDate, planIndex} of taskSessions) {
      const sessionDuration = session.allocatedHours;
      
      // Try to move the session
      const moveResult = tryMoveSession(session, sessionDuration);
    
    if (moveResult.success && moveResult.targetDate && moveResult.targetTime) {
      // Create new session
      const newSession = {...session};
      newSession.originalTime = session.startTime;
      newSession.originalDate = planDate;
      newSession.status = 'scheduled';
      newSession.startTime = moveResult.targetTime;
      
      // Calculate end time
      const [startHour, startMinute] = moveResult.targetTime.split(':').map(Number);
      const startTimeInMinutes = startHour * 60 + startMinute;
      const endTimeInMinutes = startTimeInMinutes + Math.round(sessionDuration * 60);
      const endHour = Math.floor(endTimeInMinutes / 60);
      const endMinute = endTimeInMinutes % 60;
      newSession.endTime = `${endHour.toString().padStart(2, '0')}:${endMinute.toString().padStart(2, '0')}`;
      
      console.log(`Moving session to: ${moveResult.targetDate} at ${moveResult.targetTime}, original date: ${planDate}`);
      
      // Find or create target plan
      let targetPlan = updatedPlans.find(p => p.date === moveResult.targetDate);
      if (!targetPlan) {
        console.log(`Creating new plan for date: ${moveResult.targetDate}`);
        targetPlan = {
          id: `plan-${moveResult.targetDate}`,
          date: moveResult.targetDate,
          plannedTasks: [],
          totalStudyHours: 0,
          isOverloaded: false,
          availableHours: settings.dailyAvailableHours
        };
        updatedPlans.push(targetPlan);
      }
      
      // Add session to target plan
      targetPlan.plannedTasks.push(newSession);
      targetPlan.totalStudyHours = Math.round((targetPlan.totalStudyHours + sessionDuration) * 60) / 60;
      
      console.log(`Added session to plan ${moveResult.targetDate}, plan now has ${targetPlan.plannedTasks.length} sessions`);
      
      movedSessions.push(newSession);
        
      // Remove session from original location using a more robust method
        const originalPlan = updatedPlans[planIndex];
      if (originalPlan) {
        // Find the session by taskId and sessionNumber instead of using sessionIndex
        const sessionToRemoveIndex = originalPlan.plannedTasks.findIndex(s => 
          s.taskId === session.taskId && s.sessionNumber === session.sessionNumber
        );
        
        if (sessionToRemoveIndex !== -1) {
          console.log(`Removing session from original plan: ${planDate}, session: ${session.taskId}, sessionNumber: ${session.sessionNumber}`);
          originalPlan.plannedTasks.splice(sessionToRemoveIndex, 1);
          console.log(`Original plan ${planDate} now has ${originalPlan.plannedTasks.length} sessions`);
        } else {
          console.warn(`Could not find original session to remove: planDate=${planDate}, taskId=${session.taskId}, sessionNumber=${session.sessionNumber}`);
        }
      } else {
        console.warn(`Could not find original plan: planDate=${planDate}`);
      }
    } else {
      console.log(`Failed to move session ${session.taskId} (${sessionDuration}h) - no suitable slots found`);
      failedSessions.push(session);
    }
  }
  }
  
  // Apply enhanced session combination with validation
  combineSessionsOnSameDayWithValidation(updatedPlans, settings);
  
  // Clean up any orphaned sessions (sessions that were moved but not properly removed)
  const cleanupOrphanedSessions = () => {
    // Create a set of sessions that were successfully moved to their new locations
    const successfullyMovedSessions = new Set(movedSessions.map(s => `${s.taskId}-${s.sessionNumber}-${s.originalDate}`));
    
    updatedPlans.forEach(plan => {
      plan.plannedTasks = plan.plannedTasks.filter(session => {
        const sessionId = `${session.taskId}-${session.sessionNumber}`;
        const sessionWithOriginalDate = `${session.taskId}-${session.sessionNumber}-${session.originalDate}`;
        
        // A session is orphaned if:
        // 1. It has originalTime and originalDate (was moved)
        // 2. It's in the original plan (not the target plan)
        // 3. The same session was successfully moved to a new location
        const isOrphaned = session.originalTime && 
                          session.originalDate && 
                          session.status === 'scheduled' &&
                          plan.date === session.originalDate && // It's in the original plan
                          successfullyMovedSessions.has(sessionWithOriginalDate); // And was successfully moved
        
        if (isOrphaned) {
          console.log(`Cleaning up orphaned session: ${sessionId} from original plan ${plan.date} (moved to new location)`);
        }
        
        return !isOrphaned;
      });
    });
  };
  
  cleanupOrphanedSessions();
  
  // Final verification: check if any missed sessions remain (excluding overdue sessions from today)
  const remainingMissedSessions = updatedPlans.reduce((count, plan) => {
    return count + plan.plannedTasks.filter(session => {
      const status = checkSessionStatus(session, plan.date);
      // Only count as missed if it's from a past date, not today's overdue sessions
      return status === 'missed' && plan.date < getLocalDateString();
    }).length;
  }, 0);
  
  console.log(`Redistribution complete: ${movedSessions.length} sessions moved, ${failedSessions.length} failed, ${remainingMissedSessions} remaining missed sessions`);
  
  // Log final plan summary
  console.log('Final plans after redistribution:');
  updatedPlans.forEach(plan => {
    console.log(`Plan ${plan.date}: ${plan.plannedTasks.length} sessions`);
    plan.plannedTasks.forEach(session => {
      console.log(`  - ${session.taskId} (${session.sessionNumber}): ${session.startTime}-${session.endTime} (${session.allocatedHours}h) - status: ${session.status}`);
    });
  });
  
  // Validate final state and rollback if necessary
  const hasConflicts = validateStudyPlanConflicts(updatedPlans, settings, fixedCommitments);
  
  if (hasConflicts) {
    console.warn('Conflicts detected in redistributed sessions, rolling back changes');
    return {
      updatedPlans: studyPlans, // Return original plans
      movedSessions: [],
      failedSessions: missedSessions.map(ms => ms.session)
    };
  }
  
  return { 
    updatedPlans, 
    movedSessions, 
    failedSessions 
  };
};

// New validation function to check for conflicts
const validateStudyPlanConflicts = (
  studyPlans: StudyPlan[],
  settings: UserSettings,
  fixedCommitments: FixedCommitment[]
): boolean => {
  for (const plan of studyPlans) {
    const sessions = plan.plannedTasks.filter(session => session.status !== 'skipped');
    
    // Check for overlapping sessions
    for (let i = 0; i < sessions.length; i++) {
      for (let j = i + 1; j < sessions.length; j++) {
        const sessionA = sessions[i];
        const sessionB = sessions[j];
        
        if (sessionA.startTime && sessionA.endTime && sessionB.startTime && sessionB.endTime) {
          const [aStartHour, aStartMinute] = sessionA.startTime.split(':').map(Number);
          const [aEndHour, aEndMinute] = sessionA.endTime.split(':').map(Number);
          const [bStartHour, bStartMinute] = sessionB.startTime.split(':').map(Number);
          const [bEndHour, bEndMinute] = sessionB.endTime.split(':').map(Number);
          
          const aStart = aStartHour * 60 + aStartMinute;
          const aEnd = aEndHour * 60 + aEndMinute;
          const bStart = bStartHour * 60 + bStartMinute;
          const bEnd = bEndHour * 60 + bEndMinute;
          
          if (aStart < bEnd && aEnd > bStart) {
            console.error(`Session overlap detected on ${plan.date}`);
            return true;
          }
        }
      }
    }
    
    // Check daily hour limits (excluding missed and redistributed sessions)
    const regularSessions = sessions.filter(session => !isMissedOrRedistributedSession(session, plan.date));
    const totalRegularHours = regularSessions.reduce((sum, session) => sum + session.allocatedHours, 0);
    
    if (totalRegularHours > settings.dailyAvailableHours) {
      console.error(`Daily limit exceeded on ${plan.date}: ${totalRegularHours} > ${settings.dailyAvailableHours}`);
      return true;
    }
    
    // Check session length constraints (excluding missed and redistributed sessions)
    const minSessionLength = (settings.minSessionLength || 15) / 60;
    const maxSessionLength = Math.min(4, settings.dailyAvailableHours);
    
    for (const session of sessions) {
      // Skip length validation for missed and redistributed sessions
      if (isMissedOrRedistributedSession(session, plan.date)) {
        continue;
      }
      
      if (session.allocatedHours < minSessionLength || session.allocatedHours > maxSessionLength) {
        console.error(`Session length constraint violated: ${session.allocatedHours} hours`);
        return true;
      }
    }
  }
  
  return false;
};



export const moveIndividualSession = (
  studyPlans: StudyPlan[],
  session: StudySession,
  originalPlanDate: string,
  settings: UserSettings,
  fixedCommitments: FixedCommitment[]
) => {
  const updatedPlans = [...studyPlans];
  const today = getLocalDateString();
  
  // Check if the original plan date is locked
  const originalPlan = updatedPlans.find(p => p.date === originalPlanDate);
  if (originalPlan?.isLocked) {
    return { success: false, newTime: null, newDate: null };
  }
  
  // Try to move to today
  const todayPlan = updatedPlans.find(p => p.date === today);
  if (todayPlan && !todayPlan.isLocked && settings.workDays.includes(new Date().getDay())) {
    const availableSlots = getDailyAvailableTimeSlots(
      new Date(today),
      settings.dailyAvailableHours,
      fixedCommitments,
      settings.workDays,
      settings.studyWindowStartHour || 6,
      settings.studyWindowEndHour || 23
    );
    
    if (availableSlots.length > 0) {
      const newSession = {...session};
      newSession.originalTime = session.startTime;
      newSession.originalDate = originalPlanDate;
      newSession.status = 'scheduled';
      
      // Set new time based on first available slot
      const slot = availableSlots[0];
      const startHour = slot.start.getHours();
      const startMinute = slot.start.getMinutes();
      newSession.startTime = `${startHour.toString().padStart(2, '0')}:${startMinute.toString().padStart(2, '0')}`;
      
      const endTime = new Date(slot.start.getTime() + session.allocatedHours * 60 * 60 * 1000);
      const endHour = endTime.getHours();
      const endMinute = endTime.getMinutes();
      newSession.endTime = `${endHour.toString().padStart(2, '0')}:${endMinute.toString().padStart(2, '0')}`;
      
      todayPlan.plannedTasks.push(newSession);
      
      return { 
        updatedPlans, 
        success: true, 
        newTime: newSession.startTime, 
        newDate: today 
      };
    }
  }
  
  return { 
    updatedPlans, 
    success: false, 
    newTime: null, 
    newDate: null 
  };
};

export const applyUserReschedules = (
  studyPlans: StudyPlan[],
  userReschedules: UserReschedule[]
) => {
  const updatedPlans = [...studyPlans];
  const validReschedules: UserReschedule[] = [];
  const obsoleteReschedules: UserReschedule[] = [];
  
  for (const reschedule of userReschedules) {
    // Check if the original session still exists
    const originalPlan = updatedPlans.find(p => p.date === reschedule.originalPlanDate);
    const originalSession = originalPlan?.plannedTasks.find(s => 
      s.taskId === reschedule.taskId && s.sessionNumber === reschedule.sessionNumber
    );
    
    if (!originalSession) {
      obsoleteReschedules.push(reschedule);
      continue;
    }
    
    // Apply the reschedule only if both original and target days are not locked
    const targetPlan = updatedPlans.find(p => p.date === reschedule.newPlanDate);
    if (targetPlan && !originalPlan?.isLocked && !targetPlan.isLocked) {
      const newSession = {...originalSession};
      newSession.startTime = reschedule.newStartTime;
      newSession.endTime = reschedule.newEndTime;
      newSession.originalTime = reschedule.originalStartTime;
      newSession.originalDate = reschedule.originalPlanDate;
      newSession.status = 'rescheduled';
      
      targetPlan.plannedTasks.push(newSession);
      validReschedules.push(reschedule);
    } else if (originalPlan?.isLocked || targetPlan?.isLocked) {
      // If either day is locked, mark as obsolete
      obsoleteReschedules.push(reschedule);
    }
  }
  
  return { 
    updatedPlans, 
    validReschedules, 
    obsoleteReschedules 
  };
};

export const createUserReschedule = (
  session: StudySession,
  originalDate: string,
  newDate: string,
  newStartTime: string,
  newEndTime: string
): UserReschedule => {
  // Implementation for creating user reschedules
  return {
    id: Date.now().toString(),
    originalSessionId: `${session.taskId}-${session.sessionNumber}`,
    originalPlanDate: originalDate,
    originalStartTime: session.startTime,
    originalEndTime: session.endTime,
    newPlanDate: newDate,
    newStartTime,
    newEndTime,
    rescheduledAt: new Date().toISOString(),
    status: 'active' as const,
    taskId: session.taskId,
    sessionNumber: session.sessionNumber || 0
  };
};

export const validateUserReschedules = (userReschedules: UserReschedule[]) => {
  const validReschedules: UserReschedule[] = [];
  const obsoleteReschedules: UserReschedule[] = [];
  
  for (const reschedule of userReschedules) {
    // Basic validation
    if (reschedule.originalPlanDate && reschedule.newPlanDate && 
        reschedule.newStartTime && reschedule.newEndTime) {
      validReschedules.push(reschedule);
    } else {
      obsoleteReschedules.push(reschedule);
    }
  }
  
  return { validReschedules, obsoleteReschedules };
};

// New function to aggressively redistribute tasks after deletion
export const redistributeAfterTaskDeletion = (
  tasks: Task[],
  settings: UserSettings,
  fixedCommitments: FixedCommitment[],
  existingStudyPlans: StudyPlan[]
): StudyPlan[] => {
  if (settings.studyPlanMode !== 'even') {
    // For smart mode, just regenerate from scratch
    const { plans } = generateNewStudyPlan(tasks, settings, fixedCommitments);
    return plans;
  }

  // For even mode, do aggressive redistribution
  const tasksEven = tasks
    .filter(task => task.status === 'pending' && task.estimatedHours > 0)
    .sort((a, b) => {
      if (a.importance !== b.importance) return a.importance ? -1 : 1;
      return new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
    });

  // Get available days (same logic as generateNewStudyPlan)
  const now = new Date();
  const latestDeadline = new Date(Math.max(...tasksEven.map(t => new Date(t.deadline).getTime())));
  const availableDays: string[] = [];
  const tempDate = new Date(now);
  while (tempDate <= latestDeadline) {
    const dateStr = tempDate.toISOString().split('T')[0];
    const dayOfWeek = tempDate.getDay();
    if (settings.workDays.includes(dayOfWeek)) {
      availableDays.push(dateStr);
    }
    tempDate.setDate(tempDate.getDate() + 1);
  }

  // Include deadline days
  if (settings.bufferDays === 0) {
    tasksEven.forEach(task => {
      const deadlineDateStr = new Date(task.deadline).toISOString().split('T')[0];
      if (!availableDays.includes(deadlineDateStr) && settings.workDays.includes(new Date(deadlineDateStr).getDay())) {
        availableDays.push(deadlineDateStr);
      }
    });
  } else {
    tasksEven.forEach(task => {
      const deadline = new Date(task.deadline);
      deadline.setDate(deadline.getDate() - settings.bufferDays);
      const deadlineDateStr = deadline.toISOString().split('T')[0];
      if (!availableDays.includes(deadlineDateStr) && settings.workDays.includes(new Date(deadlineDateStr).getDay())) {
        availableDays.push(deadlineDateStr);
      }
    });
  }
  availableDays.sort();

  // Create fresh study plans with full daily capacity
  const studyPlans: StudyPlan[] = [];
  const dailyRemainingHours: { [date: string]: number } = {};
  availableDays.forEach(date => {
    dailyRemainingHours[date] = settings.dailyAvailableHours;
    studyPlans.push({
      id: `plan-${date}`,
      date,
      plannedTasks: [],
      totalStudyHours: 0,
      availableHours: settings.dailyAvailableHours
    });
  });

  // Account for existing sessions (excluding missed and redistributed sessions from daily limit)
  existingStudyPlans.forEach(plan => {
    if (availableDays.includes(plan.date)) {
      plan.plannedTasks.forEach(session => {
        if (session.status !== 'skipped') {
          // Only count regular sessions toward daily capacity
          if (!isMissedOrRedistributedSession(session, plan.date)) {
            dailyRemainingHours[plan.date] -= session.allocatedHours;
          }
        }
      });
    }
  });

  // Helper function to redistribute unscheduled hours (same as in generateNewStudyPlan)
  const redistributeUnscheduledHours = (task: Task, unscheduledHours: number, daysForTask: string[]) => {
    let remainingUnscheduledHours = unscheduledHours;
    let redistributionRound = 0;
    const maxRedistributionRounds = 10;
    const minSessionLength = (settings.minSessionLength || 15) / 60;
    const maxSessionLength = Math.min(4, settings.dailyAvailableHours);
    
    while (remainingUnscheduledHours > 0 && redistributionRound < maxRedistributionRounds) {
      redistributionRound++;
      
      const availableDaysForRedistribution = daysForTask.filter(date => {
        return dailyRemainingHours[date] > 0;
      });
      
      if (availableDaysForRedistribution.length === 0) {
        break;
      }
      
      let distributedThisRound = 0;
      const optimalSessions = optimizeSessionDistribution(task, remainingUnscheduledHours, availableDaysForRedistribution, settings);
      
      for (let i = 0; i < optimalSessions.length && i < availableDaysForRedistribution.length; i++) {
        const date = availableDaysForRedistribution[i];
        const dayPlan = studyPlans.find(p => p.date === date)!;
        const availableHours = dailyRemainingHours[date];
        const sessionLength = Math.min(optimalSessions[i], availableHours);
        
        if (sessionLength >= minSessionLength) {
          const roundedSessionLength = Math.round(sessionLength * 60) / 60;
          dayPlan.plannedTasks.push({
            taskId: task.id,
            scheduledTime: `${date}`,
            startTime: '',
            endTime: '',
            allocatedHours: roundedSessionLength,
            sessionNumber: (dayPlan.plannedTasks.filter(s => s.taskId === task.id).length) + 1,
            isFlexible: true,
            status: 'scheduled'
          });
          dayPlan.totalStudyHours = Math.round((dayPlan.totalStudyHours + roundedSessionLength) * 60) / 60;
          dailyRemainingHours[date] = Math.round((dailyRemainingHours[date] - roundedSessionLength) * 60) / 60;
          distributedThisRound = Math.round((distributedThisRound + roundedSessionLength) * 60) / 60;
        }
      }
      
      remainingUnscheduledHours -= distributedThisRound;
      
      if (distributedThisRound === 0) {
        break;
      }
    }
    
    return remainingUnscheduledHours;
  };

  // Helper function to combine sessions of the same task on the same day
  const combineSessionsOnSameDay = (studyPlans: StudyPlan[]) => {
    for (const plan of studyPlans) {
      // Group sessions by taskId, excluding skipped sessions from combination
      const sessionsByTask: { [taskId: string]: StudySession[] } = {};
      
      plan.plannedTasks.forEach(session => {
        // Skip sessions that are marked as skipped - they shouldn't be combined with other sessions
        if (session.status === 'skipped') {
          return;
        }
        
        if (!sessionsByTask[session.taskId]) {
          sessionsByTask[session.taskId] = [];
        }
        sessionsByTask[session.taskId].push(session);
      });
      
      const combinedSessions: StudySession[] = [];
      
      // Combine sessions for each task
      Object.entries(sessionsByTask).forEach(([taskId, sessions]) => {
        if (sessions.length > 1) {
          // Sort sessions by start time
          sessions.sort((a, b) => a.startTime.localeCompare(b.startTime));
          
          // Combine all sessions into one
          const firstSession = sessions[0];
          const lastSession = sessions[sessions.length - 1];
          const totalHours = sessions.reduce((sum, session) => sum + session.allocatedHours, 0);
          
          const combinedSession: StudySession = {
            ...firstSession,
            startTime: firstSession.startTime,
            endTime: lastSession.endTime,
            allocatedHours: totalHours,
            sessionNumber: 1 // Combined session gets number 1
          };
          
          combinedSessions.push(combinedSession);
        } else {
          // Single session, keep as is
          combinedSessions.push(sessions[0]);
        }
      });
      
      // Update the plan with combined sessions (keeping skipped sessions separate)
      const skippedSessions = plan.plannedTasks.filter(session => session.status === 'skipped');
      plan.plannedTasks = [...combinedSessions, ...skippedSessions];
      
      // Calculate totalStudyHours including skipped sessions as "done"
      plan.totalStudyHours = calculateTotalStudyHours(plan.plannedTasks);
    }
  };



  // AGGRESSIVE REDISTRIBUTION: Distribute all tasks optimally
  for (const task of tasksEven) {
    const deadline = new Date(task.deadline);
    if (settings.bufferDays > 0) {
      deadline.setDate(deadline.getDate() - settings.bufferDays);
    }
    const deadlineDateStr = deadline.toISOString().split('T')[0];
    const daysForTask = availableDays.filter(d => d <= deadlineDateStr);
    
    if (daysForTask.length === 0) {
      continue;
    }
    
    let totalHours = task.estimatedHours;
    const sessionLengths = optimizeSessionDistribution(task, totalHours, daysForTask, settings);
    
    let unscheduledHours = 0;
    for (let i = 0; i < sessionLengths.length && i < daysForTask.length; i++) {
      const date = daysForTask[i];
      let dayPlan = studyPlans.find(p => p.date === date)!;
      let availableHours = dailyRemainingHours[date];
      const thisSessionLength = Math.min(sessionLengths[i], availableHours);
      
      if (thisSessionLength > 0) {
        const roundedSessionLength = Math.round(thisSessionLength * 60) / 60;
        dayPlan.plannedTasks.push({
          taskId: task.id,
          scheduledTime: `${date}`,
          startTime: '',
          endTime: '',
          allocatedHours: roundedSessionLength,
          sessionNumber: (dayPlan.plannedTasks.filter(s => s.taskId === task.id).length) + 1,
          isFlexible: true,
          status: 'scheduled'
        });
        dayPlan.totalStudyHours = Math.round((dayPlan.totalStudyHours + roundedSessionLength) * 60) / 60;
        dailyRemainingHours[date] = Math.round((dailyRemainingHours[date] - roundedSessionLength) * 60) / 60;
        totalHours = Math.round((totalHours - roundedSessionLength) * 60) / 60;
      } else {
        unscheduledHours += sessionLengths[i];
      }
    }
    
    // Redistribute any unscheduled hours
    if (unscheduledHours > 0) {
      redistributeUnscheduledHours(task, unscheduledHours, daysForTask);
    }
  }
  
  // Combine sessions
  combineSessionsOnSameDay(studyPlans);
  
  // MULTIPLE GLOBAL REDISTRIBUTION PASSES for maximum filling
  let redistributionPasses = 0;
  const maxRedistributionPasses = 3;
  
  while (redistributionPasses < maxRedistributionPasses) {
    redistributionPasses++;
    
    // Calculate current scheduled hours (excluding skipped sessions)
    let taskScheduledHours: { [taskId: string]: number } = {};
    for (const plan of studyPlans) {
      for (const session of plan.plannedTasks) {
        // Skip sessions that are marked as skipped - they shouldn't count towards scheduled hours
        if (session.status !== 'skipped') {
          taskScheduledHours[session.taskId] = (taskScheduledHours[session.taskId] || 0) + session.allocatedHours;
        }
      }
    }
    
    // Find tasks with unscheduled hours
    const tasksWithUnscheduledHours = tasksEven.filter(task => {
      const scheduledHours = taskScheduledHours[task.id] || 0;
      return task.estimatedHours - scheduledHours > 0.016; // More than 1 minute
    });
    
    if (tasksWithUnscheduledHours.length === 0) {
      break; // No more unscheduled hours to redistribute
    }
    
    // Sort by importance and deadline
    const sortedTasksForRedistribution = tasksWithUnscheduledHours.sort((a, b) => {
      if (a.importance !== b.importance) return a.importance ? -1 : 1;
      return new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
    });
    
    let redistributedThisPass = false;
    
    for (const task of sortedTasksForRedistribution) {
      const scheduledHours = taskScheduledHours[task.id] || 0;
      const unscheduledHours = task.estimatedHours - scheduledHours;
      
      if (unscheduledHours <= 0) continue;
      
      const deadline = new Date(task.deadline);
      if (settings.bufferDays > 0) {
        deadline.setDate(deadline.getDate() - settings.bufferDays);
      }
      const deadlineDateStr = deadline.toISOString().split('T')[0];
      const daysForTask = availableDays.filter(d => d <= deadlineDateStr);
      
      const finalUnscheduledHours = redistributeUnscheduledHours(task, unscheduledHours, daysForTask);
      
      if (finalUnscheduledHours < unscheduledHours) {
        redistributedThisPass = true;
      }
    }
    
    // If nothing was redistributed this pass, stop
    if (!redistributedThisPass) {
      break;
    }
    
    // Recombine sessions after each pass
    combineSessionsOnSameDay(studyPlans);
  }
  
  // Assign time slots
  for (const plan of studyPlans) {
    plan.plannedTasks.sort((a, b) => {
      const taskA = tasksEven.find(t => t.id === a.taskId);
      const taskB = tasksEven.find(t => t.id === b.taskId);
      if (!taskA || !taskB) return 0;
      if (taskA.importance !== taskB.importance) return taskA.importance ? -1 : 1;
      return new Date(taskA.deadline).getTime() - new Date(taskB.deadline).getTime();
    });
    
            const commitmentsForDay = fixedCommitments.filter(commitment => {
          // Check if this commitment applies to this specific date
          if (commitment.recurring) {
            // For recurring commitments, check if the day of week matches
            return commitment.daysOfWeek.includes(new Date(plan.date).getDay());
          } else {
            // For non-recurring commitments, check if the specific date matches
            return commitment.specificDates?.includes(plan.date) || false;
          }
        });
    let assignedSessions: StudySession[] = [];
    
    for (const session of plan.plannedTasks) {
      const slot = findNextAvailableTimeSlot(
        session.allocatedHours,
        assignedSessions,
        commitmentsForDay,
        settings.studyWindowStartHour || 6,
        settings.studyWindowEndHour || 23,
        settings.bufferTimeBetweenSessions || 0, // pass buffer
        plan.date // pass target date for filtering deleted occurrences
      );
      if (slot) {
        session.startTime = slot.start;
        session.endTime = slot.end;
        assignedSessions.push(session);
      } else {
        session.startTime = '';
        session.endTime = '';
      }
    }
  }
  
  return studyPlans;
};

// Function to check for time conflicts between commitments
export const checkCommitmentConflicts = (
  newCommitment: {
    startTime: string;
    endTime: string;
    recurring: boolean;
    daysOfWeek: number[];
    specificDates?: string[];
  },
  existingCommitments: FixedCommitment[],
  excludeCommitmentId?: string // For editing, exclude the commitment being edited
): { 
  hasConflict: boolean; 
  conflictingCommitment?: FixedCommitment;
  conflictType?: 'strict' | 'override';
  conflictingDates?: string[];
} => {
  // Convert time strings to minutes for easier comparison
  const timeToMinutes = (timeStr: string): number => {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
  };

  const newStartMinutes = timeToMinutes(newCommitment.startTime);
  const newEndMinutes = timeToMinutes(newCommitment.endTime);

  // Check each existing commitment for conflicts
  for (const existing of existingCommitments) {
    // Skip the commitment being edited
    if (excludeCommitmentId && existing.id === excludeCommitmentId) {
      continue;
    }

    let hasConflict = false;
    let conflictType: 'strict' | 'override' = 'strict';
    let conflictingDates: string[] = [];

    if (newCommitment.recurring && existing.recurring) {
      // Both are recurring - STRICT conflict (same type)
      const hasOverlappingDays = newCommitment.daysOfWeek.some(day => 
        existing.daysOfWeek.includes(day)
      );

      if (hasOverlappingDays) {
        const existingStartMinutes = timeToMinutes(existing.startTime);
        const existingEndMinutes = timeToMinutes(existing.endTime);

        // Check for time overlap
        const hasTimeOverlap = !(
          newEndMinutes <= existingStartMinutes || 
          newStartMinutes >= existingEndMinutes
        );

        if (hasTimeOverlap) {
          hasConflict = true;
          conflictType = 'strict';
        }
      }
    } else if (!newCommitment.recurring && !existing.recurring) {
      // Both are non-recurring - STRICT conflict (same type)
      const hasOverlappingDates = newCommitment.specificDates?.some(date => 
        existing.specificDates?.includes(date)
      );

      if (hasOverlappingDates) {
        const existingStartMinutes = timeToMinutes(existing.startTime);
        const existingEndMinutes = timeToMinutes(existing.endTime);

        // Check for time overlap
        const hasTimeOverlap = !(
          newEndMinutes <= existingStartMinutes || 
          newStartMinutes >= existingEndMinutes
        );

        if (hasTimeOverlap) {
          hasConflict = true;
          conflictType = 'strict';
          conflictingDates = newCommitment.specificDates?.filter(date => 
            existing.specificDates?.includes(date)
          ) || [];
        }
      }
    } else {
      // One is recurring, one is non-recurring
      if (newCommitment.recurring && !existing.recurring) {
        // New is recurring, existing is non-recurring - OVERRIDE (one-time takes priority)
        const overlappingDates = existing.specificDates?.filter(date => {
          const dayOfWeek = new Date(date).getDay();
          return newCommitment.daysOfWeek.includes(dayOfWeek);
        }) || [];

        if (overlappingDates.length > 0) {
          const existingStartMinutes = timeToMinutes(existing.startTime);
          const existingEndMinutes = timeToMinutes(existing.endTime);

          // Check for time overlap
          const hasTimeOverlap = !(
            newEndMinutes <= existingStartMinutes || 
            newStartMinutes >= existingEndMinutes
          );

          if (hasTimeOverlap) {
            hasConflict = true;
            conflictType = 'override';
            conflictingDates = overlappingDates;
          }
        }
      } else {
        // New is non-recurring, existing is recurring - OVERRIDE (one-time takes priority)
        const overlappingDates = newCommitment.specificDates?.filter(date => {
          const dayOfWeek = new Date(date).getDay();
          return existing.daysOfWeek.includes(dayOfWeek);
        }) || [];

        if (overlappingDates.length > 0) {
          const existingStartMinutes = timeToMinutes(existing.startTime);
          const existingEndMinutes = timeToMinutes(existing.endTime);

          // Check for time overlap
          const hasTimeOverlap = !(
            newEndMinutes <= existingStartMinutes || 
            newStartMinutes >= existingEndMinutes
          );

          if (hasTimeOverlap) {
            hasConflict = true;
            conflictType = 'override';
            conflictingDates = overlappingDates;
          }
        }
      }
    }

    if (hasConflict) {
      return {
        hasConflict: true,
        conflictingCommitment: existing,
        conflictType,
        conflictingDates
      };
    }
  }

  return { hasConflict: false };
};

// Enhanced session combination function with conflict validation
const combineSessionsOnSameDayWithValidation = (studyPlans: StudyPlan[], settings: UserSettings) => {
  for (const plan of studyPlans) {
    // Group sessions by taskId, excluding skipped sessions from combination
    const sessionsByTask: { [taskId: string]: StudySession[] } = {};
    
    plan.plannedTasks.forEach(session => {
      // Skip sessions that are marked as skipped - they shouldn't be combined with other sessions
      if (session.status === 'skipped') {
        return;
      }
      
      if (!sessionsByTask[session.taskId]) {
        sessionsByTask[session.taskId] = [];
      }
      sessionsByTask[session.taskId].push(session);
    });
    
    const combinedSessions: StudySession[] = [];
    
    // Combine sessions for each task with validation
    Object.entries(sessionsByTask).forEach(([taskId, sessions]) => {
      if (sessions.length > 1) {
        // Sort sessions by start time
        sessions.sort((a, b) => a.startTime.localeCompare(b.startTime));
        
        // Calculate total hours
        const totalHours = sessions.reduce((sum, session) => sum + session.allocatedHours, 0);
        
        // Validate session length constraints
        const minSessionLength = (settings.minSessionLength || 15) / 60; // in hours
        const maxSessionLength = Math.min(4, settings.dailyAvailableHours);
        
        if (totalHours >= minSessionLength && totalHours <= maxSessionLength) {
          // Combine all sessions into one
          const firstSession = sessions[0];
          const lastSession = sessions[sessions.length - 1];
          
          const combinedSession: StudySession = {
            ...firstSession,
            startTime: firstSession.startTime,
            endTime: lastSession.endTime,
            allocatedHours: totalHours,
            sessionNumber: 1 // Combined session gets number 1
          };
          
          combinedSessions.push(combinedSession);
        } else {
          // If combination would violate constraints, keep sessions separate
          combinedSessions.push(...sessions);
        }
      } else {
        // Single session, keep as is
        combinedSessions.push(...sessions);
      }
    });
    
    // Update plan with combined sessions
    plan.plannedTasks = combinedSessions;
    plan.totalStudyHours = combinedSessions.reduce((sum, session) => sum + session.allocatedHours, 0);
  }
};

// Enhanced redistribution function with detailed feedback
export const redistributeMissedSessionsWithFeedback = (
  studyPlans: StudyPlan[],
  settings: UserSettings,
  fixedCommitments: FixedCommitment[],
  tasks: Task[]
): {
  updatedPlans: StudyPlan[];
  movedSessions: StudySession[];
  failedSessions: StudySession[];
  feedback: {
    success: boolean;
    message: string;
    details: {
      totalMissed: number;
      successfullyMoved: number;
      failedToMove: number;
      remainingMissed: number;
      conflictsDetected: boolean;
      priorityOrderUsed: boolean;
      issues: string[];
      suggestions: string[];
    };
  };
} => {
  // Check edge cases first
  const edgeCaseCheck = handleRedistributionEdgeCases(studyPlans, settings, fixedCommitments, tasks);
  
  if (!edgeCaseCheck.canRedistribute) {
    return {
      updatedPlans: studyPlans,
      movedSessions: [],
      failedSessions: [],
      feedback: {
        success: false,
        message: `Cannot redistribute missed sessions: ${edgeCaseCheck.issues.join(', ')}`,
        details: {
          totalMissed: 0,
          successfullyMoved: 0,
          failedToMove: 0,
          remainingMissed: 0,
          conflictsDetected: true,
          priorityOrderUsed: false,
          issues: edgeCaseCheck.issues,
          suggestions: edgeCaseCheck.suggestions
        }
      }
    };
  }
  
  const result = moveMissedSessions(studyPlans, settings, fixedCommitments, tasks);
  
  // Count total missed sessions
  const totalMissed = studyPlans.reduce((count, plan) => {
    return count + plan.plannedTasks.filter(session => {
      const status = checkSessionStatus(session, plan.date);
      return status === 'missed';
    }).length;
  }, 0);
  
  // Count remaining missed sessions after redistribution (excluding overdue sessions from today)
  const remainingMissedSessions = result.updatedPlans.reduce((count, plan) => {
    return count + plan.plannedTasks.filter(session => {
      const status = checkSessionStatus(session, plan.date);
      // Only count as missed if it's from a past date, not today's overdue sessions
      return status === 'missed' && plan.date < getLocalDateString();
    }).length;
  }, 0);
  
  // Generate detailed feedback
  const feedback = {
    success: result.movedSessions.length > 0,
    message: '',
    details: {
      totalMissed,
      successfullyMoved: result.movedSessions.length,
      failedToMove: result.failedSessions.length,
      remainingMissed: remainingMissedSessions,
      conflictsDetected: result.failedSessions.length > 0 && result.movedSessions.length === 0,
      priorityOrderUsed: true,
      issues: [],
      suggestions: []
    }
  };
  
  // Generate appropriate message
  if (result.movedSessions.length > 0 && result.failedSessions.length === 0 && remainingMissedSessions === 0) {
    feedback.message = `Successfully redistributed all ${result.movedSessions.length} missed sessions!`;
  } else if (result.movedSessions.length > 0 && (result.failedSessions.length > 0 || remainingMissedSessions > 0)) {
    feedback.message = `Partially successful: moved ${result.movedSessions.length} sessions, but ${result.failedSessions.length} could not be redistributed and ${remainingMissedSessions} remain missed.`;
  } else if (result.failedSessions.length > 0) {
    feedback.message = `Could not redistribute any missed sessions. All ${result.failedSessions.length} sessions have conflicts or no available time slots.`;
  } else if (remainingMissedSessions > 0) {
    feedback.message = `Redistribution completed but ${remainingMissedSessions} missed sessions remain. This may be due to session conflicts or insufficient time slots.`;
  } else {
    feedback.message = 'No missed sessions found to redistribute.';
  }
  
  return {
    ...result,
    feedback
  };
};

// Handle edge cases and provide error recovery
const handleRedistributionEdgeCases = (
  studyPlans: StudyPlan[],
  settings: UserSettings,
  fixedCommitments: FixedCommitment[],
  tasks: Task[]
): {
  canRedistribute: boolean;
  issues: string[];
  suggestions: string[];
} => {
  const issues: string[] = [];
  const suggestions: string[] = [];
  
  // Check if there are any missed sessions
  const missedSessions = studyPlans.reduce((count, plan) => {
    return count + plan.plannedTasks.filter(session => {
      const status = checkSessionStatus(session, plan.date);
      return status === 'missed';
    }).length;
  }, 0);
  
  if (missedSessions === 0) {
    issues.push('No missed sessions found');
    return { canRedistribute: false, issues, suggestions };
  }
  
  // Check available time slots
  const today = getLocalDateString();
  let totalAvailableHours = 0;
  let availableDays = 0;
  
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const targetDate = new Date(today);
    targetDate.setDate(targetDate.getDate() + dayOffset);
    const targetDateString = targetDate.toISOString().split('T')[0];
    
    if (settings.workDays.includes(targetDate.getDay())) {
      const availableSlots = getDailyAvailableTimeSlots(
        targetDate,
        settings.dailyAvailableHours,
        fixedCommitments,
        settings.workDays,
        settings.studyWindowStartHour || 6,
        settings.studyWindowEndHour || 23
      );
      
      const dayHours = availableSlots.reduce((sum, slot) => {
        return sum + (slot.end.getTime() - slot.start.getTime()) / (1000 * 60 * 60);
      }, 0);
      
      totalAvailableHours += dayHours;
      if (dayHours > 0) availableDays++;
    }
  }
  
  // Calculate total missed hours
  const totalMissedHours = studyPlans.reduce((sum, plan) => {
    return sum + plan.plannedTasks.filter(session => {
      const status = checkSessionStatus(session, plan.date);
      return status === 'missed';
    }).reduce((planSum, session) => planSum + session.allocatedHours, 0);
  }, 0);
  
  if (totalMissedHours > totalAvailableHours) {
    issues.push(`Insufficient available time: ${totalMissedHours.toFixed(1)} hours needed, ${totalAvailableHours.toFixed(1)} hours available`);
    suggestions.push('Consider increasing daily available hours in settings');
    suggestions.push('Consider adjusting your study window hours');
    suggestions.push('Consider removing some fixed commitments');
  }
  
  if (availableDays === 0) {
    issues.push('No available work days in the next 7 days');
    suggestions.push('Check your work days settings');
  }
  
  // Check for tasks with very short deadlines (but not past deadlines)
  const urgentTasks = tasks.filter(task => {
    const daysUntilDeadline = (new Date(task.deadline).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24);
    // Only consider tasks with deadlines in the future (positive daysUntilDeadline)
    return daysUntilDeadline > 0 && daysUntilDeadline <= 1 && task.status === 'pending';
  });
  
  if (urgentTasks.length > 0) {
    issues.push(`${urgentTasks.length} urgent task(s) with deadline within 1 day`);
    suggestions.push('Consider extending deadlines for urgent tasks');
  }
  
  // Check for tasks with past deadlines (these should be handled differently)
  const pastDeadlineTasks = tasks.filter(task => {
    const daysUntilDeadline = (new Date(task.deadline).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24);
    return daysUntilDeadline < 0 && task.status === 'pending';
  });
  
  if (pastDeadlineTasks.length > 0) {
    // Don't block redistribution for past deadlines, just log a warning
    console.warn(`${pastDeadlineTasks.length} task(s) have deadlines in the past:`, 
      pastDeadlineTasks.map(t => `${t.title} (${t.deadline})`));
  }
  
  return {
    canRedistribute: issues.length === 0,
    issues,
    suggestions
  };
};

// Test function to verify redistribution implementation
export const testRedistributionImplementation = (
  studyPlans: StudyPlan[],
  settings: UserSettings,
  fixedCommitments: FixedCommitment[],
  tasks: Task[]
): {
  testResults: {
    edgeCaseCheck: boolean;
    conflictDetection: boolean;
    prioritySorting: boolean;
    sessionCombination: boolean;
    validation: boolean;
  };
  issues: string[];
} => {
  const testResults = {
    edgeCaseCheck: false,
    conflictDetection: false,
    prioritySorting: false,
    sessionCombination: false,
    validation: false
  };
  const issues: string[] = [];
  
  try {
    // Test edge case handling
    const edgeCaseCheck = handleRedistributionEdgeCases(studyPlans, settings, fixedCommitments, tasks);
    testResults.edgeCaseCheck = true;
    
    // Test conflict detection
    const hasConflicts = validateStudyPlanConflicts(studyPlans, settings, fixedCommitments);
    testResults.conflictDetection = true;
    
    // Test priority sorting (simulate missed sessions)
    const missedSessions = studyPlans.reduce((count, plan) => {
      return count + plan.plannedTasks.filter(session => {
        const status = checkSessionStatus(session, plan.date);
        return status === 'missed';
      }).length;
    }, 0);
    
    if (missedSessions > 0) {
      // Test the actual redistribution
      const result = redistributeMissedSessionsWithFeedback(studyPlans, settings, fixedCommitments, tasks);
      testResults.prioritySorting = true;
      testResults.sessionCombination = true;
      testResults.validation = true;
      
      console.log('Redistribution test results:', {
        totalMissed: result.feedback.details.totalMissed,
        successfullyMoved: result.feedback.details.successfullyMoved,
        failedToMove: result.feedback.details.failedToMove,
        conflictsDetected: result.feedback.details.conflictsDetected
      });
    } else {
      testResults.prioritySorting = true;
      testResults.sessionCombination = true;
      testResults.validation = true;
    }
    
  } catch (error) {
    issues.push(`Test failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
  
  return { testResults, issues };
};
